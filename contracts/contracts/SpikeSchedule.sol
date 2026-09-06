// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title SpikeSchedule
 * @notice Throwaway contract for the Deadman de-risking spikes. NOT HoldEscrow.
 *
 * Spike 1: does a HIP-1215 scheduled call fire unattended on current testnet?
 * Spike 2: can a contract delete a schedule it created, by either of the two
 *          documented delete paths?
 *
 * Everything here is written to produce evidence rather than to be elegant.
 *
 * Why raw `call` instead of a typed IHederaScheduleService interface: HIP-1215
 * says these functions never revert, they return failure codes. A typed
 * interface throws away the returndata on a malformed response and leaves us
 * with an opaque revert. We want the raw bytes in an event, on the mirror node,
 * where they can be read after the fact. Selectors are verified against the HIP
 * before every deploy by scripts/verify-selectors.mjs.
 */
contract SpikeSchedule {
    /*//////////////////////////////////////////////////////////////
                          SYSTEM CONTRACTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Hedera Schedule Service, entity 0.0.363.
    address internal constant HSS = address(0x16b);

    /// @dev keccak256("scheduleCall(address,uint256,uint256,uint64,bytes)")[0:4]
    bytes4 internal constant SEL_SCHEDULE_CALL = 0x6f5bfde8;
    /// @dev keccak256("hasScheduleCapacity(uint256,uint256)")[0:4]
    bytes4 internal constant SEL_HAS_CAPACITY = 0xdfb4a999;
    /// @dev keccak256("deleteSchedule(address)")[0:4] — called on HSS.
    bytes4 internal constant SEL_DELETE_SCHEDULE = 0x72d42394;
    /// @dev keccak256("deleteSchedule()")[0:4] — "redirect" form, called on the
    ///      schedule address itself. HIP-1215 says a contract or EOA may attempt
    ///      it. It does not say who is authorised, which is why spike 2 exists.
    bytes4 internal constant SEL_DELETE_REDIRECT = 0xc61dea85;

    /// @dev HAPI ResponseCodeEnum ordinal for SUCCESS.
    int64 internal constant HSS_SUCCESS = 22;

    /*//////////////////////////////////////////////////////////////
                              CONFIG
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev The calling contract pays gas at EXECUTION time out of its own
     *      balance. If it is short at the expiry second, the scheduled call
     *      silently does not happen — on camera, during the one demo everything
     *      rests on. So arming asserts a floor rather than trusting the operator
     *      to have funded it.
     *
     *      On Hedera the EVM sees balances in weibars, 1 HBAR = 1e18 weibar, so
     *      `ether` units read as HBAR here.
     */
    uint256 public constant MIN_BALANCE = 5 ether; // 5 HBAR

    /// @dev Matches the HIP-1215 reference retry pattern.
    uint256 internal constant MAX_PROBES = 8;

    /*//////////////////////////////////////////////////////////////
                               STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice Bumped by ping(). The variable spike 1 is actually testing.
    uint256 public pingCount;
    /// @notice block.timestamp observed INSIDE a network-executed call.
    uint256 public lastPingTimestamp;
    /**
     * @notice msg.sender observed inside a network-executed call.
     * @dev Undocumented. HoldEscrow.refund() will need to know whether it can
     *      restrict its caller at all, so we record it before we design around it.
     */
    address public lastPingSender;
    /// @notice Which arming this ping came from.
    bytes32 public lastTag;
    /// @notice How many times arm() has been called. Also feeds the fallback seed.
    uint256 public armCount;

    /*//////////////////////////////////////////////////////////////
                               EVENTS
    //////////////////////////////////////////////////////////////*/

    event Armed(
        bytes32 indexed tag,
        address scheduleAddress,
        uint256 expirySecond,
        uint256 requestedSecond,
        int64 code,
        uint8 probesUsed,
        uint256 balanceAtArm
    );

    event Pinged(bytes32 indexed tag, address sender, uint256 timestamp, uint256 count);

    /// @dev `path` is "hss" or "redirect". Emitted whether or not the delete worked.
    event CancelAttempt(string path, address scheduleAddress, bool callOk, int64 code, bytes returnData);

    /// @dev Raw system-contract returndata, kept so a malformed response is
    ///      diagnosable from the mirror node instead of vanishing into a revert.
    event HssRaw(string fn, bool callOk, bytes returnData);

    event Funded(address from, uint256 amount, uint256 newBalance);

    /*//////////////////////////////////////////////////////////////
                               ERRORS
    //////////////////////////////////////////////////////////////*/

    error InsufficientBalance(uint256 have, uint256 need);
    error NoUnsaturatedSecond(uint256 requestedSecond, uint256 probes);
    error HssCallReverted(string fn, bytes returnData);
    error HssMalformedReturn(string fn, bytes returnData);
    error HssNotSuccess(string fn, int64 code);
    error HssZeroScheduleAddress(int64 code);

    /*//////////////////////////////////////////////////////////////
                            SCHEDULED TARGET
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice The function the network calls on our behalf.
     * @dev DELIBERATELY UNRESTRICTED. Gating this on `msg.sender == address(this)`
     *      when we do not yet know what the network executes it as would fail the
     *      call and teach us nothing. Record first, restrict in HoldEscrow once
     *      spike 1 tells us who the sender is.
     */
    function ping(bytes32 tag) external {
        pingCount += 1;
        lastPingTimestamp = block.timestamp;
        lastPingSender = msg.sender;
        lastTag = tag;
        emit Pinged(tag, msg.sender, block.timestamp, pingCount);
    }

    /*//////////////////////////////////////////////////////////////
                               ARMING
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Book a call to ping() `delaySeconds` from now.
     * @return scheduleAddress the created schedule, as a long-zero EVM address
     * @return expirySecond    the second actually chosen (may differ from requested)
     * @return probesUsed      0 means the first-choice second was free and the
     *                         jitter fallback never ran — see spike 1 caveat
     */
    function arm(uint256 delaySeconds, uint256 gasLimit, bytes32 tag)
        external
        returns (address scheduleAddress, uint256 expirySecond, uint8 probesUsed)
    {
        uint256 bal = address(this).balance;
        if (bal < MIN_BALANCE) revert InsufficientBalance(bal, MIN_BALANCE);

        armCount += 1;

        uint256 requestedSecond = block.timestamp + delaySeconds;
        (expirySecond, probesUsed) = _findAvailableSecond(requestedSecond, gasLimit);

        bytes memory innerCallData = abi.encodeWithSelector(this.ping.selector, tag);

        (bool callOk, bytes memory ret) = HSS.call(
            abi.encodeWithSelector(
                SEL_SCHEDULE_CALL,
                address(this),
                expirySecond,
                gasLimit,
                uint64(0), // no value on the scheduled call; see plan note on tinybar vs weibar
                innerCallData
            )
        );
        emit HssRaw("scheduleCall", callOk, ret);

        // HIP-1215 says scheduleCall never reverts. If it did, that is itself
        // the finding, and the returndata is already in the event above.
        if (!callOk) revert HssCallReverted("scheduleCall", ret);
        if (ret.length < 64) revert HssMalformedReturn("scheduleCall", ret);

        int64 code;
        (code, scheduleAddress) = abi.decode(ret, (int64, address));

        // Both halves. A saturated second returns a ZERO ADDRESS with a non-22
        // code (SCHEDULE_EXPIRY_IS_BUSY) and would otherwise sail straight through.
        if (code != HSS_SUCCESS) revert HssNotSuccess("scheduleCall", code);
        if (scheduleAddress == address(0)) revert HssZeroScheduleAddress(code);

        emit Armed(tag, scheduleAddress, expirySecond, requestedSecond, code, probesUsed, bal);
    }

    /*//////////////////////////////////////////////////////////////
                        CAPACITY AND JITTER
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev HIP-1215's own findAvailableSecond pattern — exponential backoff with
     *      non-manipulable jitter so contracts probing the same ideal second
     *      scatter instead of stampeding — plus the boundary skip below.
     */
    function _findAvailableSecond(uint256 requestedSecond, uint256 gasLimit)
        internal
        view
        returns (uint256 second, uint8 probesUsed)
    {
        if (_secondUsable(requestedSecond, gasLimit)) return (requestedSecond, 0);

        bytes32 seed = _jitterSeed();
        for (uint256 i = 0; i < MAX_PROBES; ++i) {
            uint256 baseDelay = 1 << i; // 1, 2, 4, 8, ...
            uint256 jitter = uint256(uint16(uint256(keccak256(abi.encodePacked(seed, i))))) % baseDelay;
            uint256 candidate = requestedSecond + baseDelay + jitter;
            if (_secondUsable(candidate, gasLimit)) return (candidate, uint8(i + 1));
        }
        revert NoUnsaturatedSecond(requestedSecond, MAX_PROBES);
    }

    /**
     * @dev Boundary skip: scheduled work clusters on minute and hour boundaries,
     *      not decimal ones.
     *
     *      NOTE for review: `% 3600 == 0` is a strict subset of `% 60 == 0`, so
     *      the hour test can never fire independently of the minute test. It is
     *      written out as specified rather than silently collapsed, because the
     *      intent may have been a *band* around the hour rather than the exact
     *      second. Open question for Alex — see the spike report.
     */
    function _secondUsable(uint256 candidate, uint256 gasLimit) internal view returns (bool) {
        if (candidate % 60 == 0) return false;
        if (candidate % 3600 == 0) return false;
        return _hasCapacity(candidate, gasLimit);
    }

    /**
     * @notice Thin view over the HSS capacity probe.
     * @dev Returns false for an INVALID expiry too — not after the current
     *      consensus second, or beyond the 62-day horizon — which is
     *      indistinguishable from "saturated". A false here is therefore NOT
     *      evidence of congestion, and no spike result may report it as such.
     */
    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) public view returns (bool) {
        return _hasCapacity(expirySecond, gasLimit);
    }

    function _hasCapacity(uint256 expirySecond, uint256 gasLimit) internal view returns (bool) {
        (bool callOk, bytes memory ret) =
            HSS.staticcall(abi.encodeWithSelector(SEL_HAS_CAPACITY, expirySecond, gasLimit));
        if (!callOk || ret.length < 32) return false;
        return abi.decode(ret, (bool));
    }

    function _jitterSeed() internal view virtual returns (bytes32) {
        // Deterministic fallback. Replaced by a probed randomness source in the
        // next commit — we do not assume prevrandao works on Hedera.
        return keccak256(abi.encodePacked(block.timestamp, address(this), armCount, pingCount));
    }

    /*//////////////////////////////////////////////////////////////
                          CANCEL — BOTH PATHS
    //////////////////////////////////////////////////////////////*/

    /// @notice Path A: deleteSchedule(address) on HSS. Reverts on failure.
    function cancelViaHss(address scheduleAddress) external {
        (bool callOk, int64 code,) = _tryCancelViaHss(scheduleAddress);
        if (!callOk) revert HssCallReverted("deleteSchedule(address)", "");
        if (code != HSS_SUCCESS) revert HssNotSuccess("deleteSchedule(address)", code);
    }

    /// @notice Path B: redirect deleteSchedule() on the schedule itself. Reverts on failure.
    function cancelViaRedirect(address scheduleAddress) external {
        (bool callOk, int64 code,) = _tryCancelViaRedirect(scheduleAddress);
        if (!callOk) revert HssCallReverted("deleteSchedule()", "");
        if (code != HSS_SUCCESS) revert HssNotSuccess("deleteSchedule()", code);
    }

    /**
     * @notice Non-reverting variants. Spike 2 needs the ACTUAL failure code, not
     *         "it reverted" — the code is what tells us whether the answer is
     *         "nobody may delete" or "only an external signer may delete", and
     *         those are different products.
     */
    function tryCancelViaHss(address scheduleAddress)
        external
        returns (bool callOk, int64 code, bytes memory returnData)
    {
        return _tryCancelViaHss(scheduleAddress);
    }

    function tryCancelViaRedirect(address scheduleAddress)
        external
        returns (bool callOk, int64 code, bytes memory returnData)
    {
        return _tryCancelViaRedirect(scheduleAddress);
    }

    function _tryCancelViaHss(address scheduleAddress)
        internal
        returns (bool callOk, int64 code, bytes memory returnData)
    {
        (callOk, returnData) = HSS.call(abi.encodeWithSelector(SEL_DELETE_SCHEDULE, scheduleAddress));
        code = _decodeCode(callOk, returnData);
        emit CancelAttempt("hss", scheduleAddress, callOk, code, returnData);
    }

    function _tryCancelViaRedirect(address scheduleAddress)
        internal
        returns (bool callOk, int64 code, bytes memory returnData)
    {
        // Note the target: the SCHEDULE address, not HSS.
        (callOk, returnData) = scheduleAddress.call(abi.encodeWithSelector(SEL_DELETE_REDIRECT));
        code = _decodeCode(callOk, returnData);
        emit CancelAttempt("redirect", scheduleAddress, callOk, code, returnData);
    }

    /// @dev type(int64).min is our sentinel for "no code could be decoded".
    function _decodeCode(bool callOk, bytes memory returnData) internal pure returns (int64) {
        if (!callOk || returnData.length < 32) return type(int64).min;
        return abi.decode(returnData, (int64));
    }

    /*//////////////////////////////////////////////////////////////
                              FUNDING
    //////////////////////////////////////////////////////////////*/

    receive() external payable {
        emit Funded(msg.sender, msg.value, address(this).balance);
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }
}
