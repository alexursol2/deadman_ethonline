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

    /// @dev HIP-351 pseudorandom number generator, entity 0.0.361.
    address internal constant PRNG = address(0x169);

    /// @dev keccak256("getPseudorandomSeed()")[0:4]
    bytes4 internal constant SEL_PRNG_SEED = 0xd83bf9a1;

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
     *      UNITS — measured on testnet, not assumed. See scripts/units-probe.cjs:
     *
     *        address(this).balance  (EVM BALANCE opcode) -> TINYBARS, 1e8 per HBAR
     *        eth_getBalance         (JSON-RPC)           -> WEIBARS,  1e18 per HBAR
     *
     *      The two differ by exactly 1e10 for the same account. Solidity's
     *      `ether` literal is 1e18, so `balance >= 5 ether` compares tinybars
     *      against weibars and can never pass. That is how the first arm() on
     *      testnet reverted: InsufficientBalance(2000000000, 5000000000000000000)
     *      for a contract holding 20 HBAR.
     *
     *      It failed loudly, which was luck. The same mistake in the other
     *      direction — a weibar quantity compared against a tinybar threshold —
     *      passes trivially and would put an underfunded contract into the demo.
     *      So every on-chain HBAR quantity in this codebase is named for its unit.
     */
    uint256 internal constant TINYBAR_PER_HBAR = 1e8;

    /// @notice Arming floor, in TINYBARS. 5 HBAR.
    uint256 public constant MIN_BALANCE_TINYBAR = 5 * TINYBAR_PER_HBAR;

    /// @dev Matches the HIP-1215 reference retry pattern.
    uint256 internal constant MAX_PROBES = 8;

    /// @dev Which randomness source seeded the jitter. Recorded, never assumed.
    uint8 internal constant SEED_PRNG = 1;       // 0x169, HIP-351
    uint8 internal constant SEED_PREVRANDAO = 2; // block.prevrandao
    uint8 internal constant SEED_FALLBACK = 3;   // keccak of local state

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
        uint256 balanceAtArmTinybar,
        uint8 seedSource,
        bytes32 prevrandao,
        bytes32 prngSeed
    );

    event Pinged(bytes32 indexed tag, address sender, uint256 timestamp, uint256 count);

    /// @dev `value` is echoed exactly as passed to scheduleCall, in whatever unit that turns out
    ///      to be — the point of the spike is that we do not yet know. balanceBefore is TINYBARS.
    event ArmedWithValue(
        address indexed to,
        address scheduleAddress,
        uint256 expirySecond,
        int64 code,
        uint64 value,
        uint256 balanceBeforeTinybar
    );

    event RandomnessProbe(bytes32 prevrandao, bytes32 prngSeed, bool prngOk, uint256 blockNumber, uint256 timestamp);

    /// @dev `path` is "hss" or "redirect". Emitted whether or not the delete worked.
    event CancelAttempt(string path, address scheduleAddress, bool callOk, int64 code, bytes returnData);

    /// @dev Raw system-contract returndata, kept so a malformed response is
    ///      diagnosable from the mirror node instead of vanishing into a revert.
    event HssRaw(string fn, bool callOk, bytes returnData);

    event Funded(address from, uint256 amount, uint256 newBalance);

    /*//////////////////////////////////////////////////////////////
                               ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @dev Both values in TINYBARS. See the MIN_BALANCE_TINYBAR note.
    error InsufficientBalance(uint256 haveTinybar, uint256 needTinybar);
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
        if (bal < MIN_BALANCE_TINYBAR) revert InsufficientBalance(bal, MIN_BALANCE_TINYBAR);

        armCount += 1;

        uint256 requestedSecond = block.timestamp + delaySeconds;

        // Seeded eagerly, even when the first candidate is free, so the spike
        // records both randomness sources from inside a REAL scheduling
        // transaction rather than from a staticcall. HoldEscrow should make this
        // lazy — it is a wasted system-contract call whenever probing is not needed.
        (bytes32 seed, uint8 seedSource) = _jitterSeedWithSource();
        (expirySecond, probesUsed) = _findAvailableSecond(requestedSecond, gasLimit, seed);

        bytes memory innerCallData = abi.encodeWithSelector(this.ping.selector, tag);

        (bool callOk, bytes memory ret) = HSS.call(
            abi.encodeWithSelector(
                SEL_SCHEDULE_CALL,
                address(this),
                expirySecond,
                gasLimit,
                // Value in TINYBARS: uint64 cannot hold a weibar amount of any
                // size (total supply in weibar overflows it), and the EVM balance
                // opcode is tinybars, so the parameter must be tinybars too.
                // Inferred, not exercised — both spikes pass zero.
                uint64(0),
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

        emit Armed(
            tag,
            scheduleAddress,
            expirySecond,
            requestedSecond,
            code,
            probesUsed,
            bal,
            seedSource,
            bytes32(block.prevrandao),
            seed
        );
    }

    /**
     * @notice Arm a scheduled call that CARRIES VALUE to an arbitrary target.
     *
     * @dev Exists to measure the unit of scheduleCall's `uint64 value`. Every
     *      other arming in this repo passes zero, which is why the unit is still
     *      an inference rather than a measurement.
     *
     *      The balance floor is raised to MIN_BALANCE_TINYBAR + value. That
     *      addition assumes value is in tinybars — the hypothesis under test. If
     *      the hypothesis is wrong the assert is merely conservative, never
     *      permissive, so it cannot mask the result it is meant to measure.
     *
     * @param value the value parameter, passed through UNCONVERTED and unjudged
     */
    function armWithValue(
        address to,
        uint256 delaySeconds,
        uint256 gasLimit,
        uint64 value,
        bytes calldata callData
    ) external returns (address scheduleAddress, uint256 expirySecond, uint8 probesUsed) {
        uint256 bal = address(this).balance;
        uint256 floor = MIN_BALANCE_TINYBAR + uint256(value);
        if (bal < floor) revert InsufficientBalance(bal, floor);

        armCount += 1;

        uint256 requestedSecond = block.timestamp + delaySeconds;
        (bytes32 seed, ) = _jitterSeedWithSource();
        (expirySecond, probesUsed) = _findAvailableSecond(requestedSecond, gasLimit, seed);

        int64 code;
        (code, scheduleAddress) = _doScheduleCall(to, expirySecond, gasLimit, value, callData);

        emit ArmedWithValue(to, scheduleAddress, expirySecond, code, value, bal);
    }

    /**
     * @dev The raw scheduleCall, extracted so armWithValue does not blow the
     *      stack. Kept separate from arm()'s inline copy on purpose: arm() is
     *      the code path already proven on testnet by spike 1, and refactoring
     *      it to share this helper would invalidate that evidence for no gain in
     *      a contract that is being thrown away. HoldEscrow will have exactly
     *      one of these.
     *
     *      Asserts BOTH halves of the return, as everywhere else: a saturated
     *      second yields a zero address with a non-22 code and no revert.
     */
    function _doScheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes calldata callData
    ) internal returns (int64 code, address scheduleAddress) {
        (bool callOk, bytes memory ret) =
            HSS.call(abi.encodeWithSelector(SEL_SCHEDULE_CALL, to, expirySecond, gasLimit, value, callData));
        emit HssRaw("scheduleCall(value)", callOk, ret);

        if (!callOk) revert HssCallReverted("scheduleCall(value)", ret);
        if (ret.length < 64) revert HssMalformedReturn("scheduleCall(value)", ret);

        (code, scheduleAddress) = abi.decode(ret, (int64, address));
        if (code != HSS_SUCCESS) revert HssNotSuccess("scheduleCall(value)", code);
        if (scheduleAddress == address(0)) revert HssZeroScheduleAddress(code);
    }

    /*//////////////////////////////////////////////////////////////
                        CAPACITY AND JITTER
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev HIP-1215's own findAvailableSecond pattern — exponential backoff with
     *      non-manipulable jitter so contracts probing the same ideal second
     *      scatter instead of stampeding — plus the boundary skip below.
     */
    function _findAvailableSecond(uint256 requestedSecond, uint256 gasLimit, bytes32 seed)
        internal
        view
        returns (uint256 second, uint8 probesUsed)
    {
        if (_secondUsable(requestedSecond, gasLimit)) return (requestedSecond, 0);

        for (uint256 i = 0; i < MAX_PROBES; ++i) {
            uint256 baseDelay = 1 << i; // 1, 2, 4, 8, ...
            uint256 jitter = uint256(uint16(uint256(keccak256(abi.encodePacked(seed, i))))) % baseDelay;
            uint256 candidate = requestedSecond + baseDelay + jitter;
            if (_secondUsable(candidate, gasLimit)) return (candidate, uint8(i + 1));
        }
        revert NoUnsaturatedSecond(requestedSecond, MAX_PROBES);
    }

    /**
     * @dev Boundary skip: scheduled work clusters on minute boundaries, not
     *      decimal ones.
     *
     *      A `% 3600 == 0` hour test was specified alongside this and has been
     *      removed: every hour boundary is also a minute boundary, so it was a
     *      strict subset of the check above and could never fire. Alex confirmed
     *      the removal. If hour-adjacent clustering turns out to be real, the fix
     *      is a *band* around the hour, not an exact-second test.
     */
    function _secondUsable(uint256 candidate, uint256 gasLimit) internal view returns (bool) {
        if (candidate % 60 == 0) return false;
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

    /*//////////////////////////////////////////////////////////////
                            RANDOMNESS PROBE
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Read BOTH candidate randomness sources and report which works.
     *
     * @dev We do not assume `block.prevrandao` is meaningful on Hedera. Hedera's
     *      system contract docs document a PRNG at 0x169 (HIP-351) and never
     *      mention PREVRANDAO, while HIP-1215's own findAvailableSecond example
     *      seeds its jitter from prevrandao. Both cannot be the right answer, so
     *      we measure instead of picking.
     *
     *      Why it matters more than it looks: jitter seeded from a CONSTANT is
     *      worse than no jitter at all. Every contract using the reference
     *      pattern would derive the same "random" offsets and pick the same
     *      second, converting the intended scatter into a stampede — while
     *      appearing to work. A zero or constant prevrandao is therefore a
     *      finding worth reporting to Hedera, not a detail.
     *
     *      Not a view: the 0x169 call is a system-contract call that mutates
     *      network-side state, so it must run in a transaction to be trustworthy.
     */
    function probeRandomness() external returns (bytes32 prevrandao, bytes32 prngSeed, bool prngOk) {
        prevrandao = bytes32(block.prevrandao);
        (prngOk, prngSeed) = _prngSeed();
        emit RandomnessProbe(prevrandao, prngSeed, prngOk, block.number, block.timestamp);
    }

    function _prngSeed() internal returns (bool ok, bytes32 seed) {
        (bool callOk, bytes memory ret) = PRNG.call(abi.encodeWithSelector(SEL_PRNG_SEED));
        if (!callOk || ret.length < 32) return (false, bytes32(0));
        seed = abi.decode(ret, (bytes32));
        // A zero seed is a working call returning a useless value. Treat it as
        // unusable rather than silently seeding jitter with nothing.
        ok = seed != bytes32(0);
    }

    /**
     * @dev Seed selection, in preference order, with the choice recorded in the
     *      Armed event so the spike report can say which one actually carried a
     *      real scheduling transaction rather than which one a staticcall liked.
     *
     *      HoldEscrow will hard-code whichever source the spike proves. Silent
     *      fallback is fine for a spike and is not fine for the refund path.
     */
    function _jitterSeedWithSource() internal returns (bytes32 seed, uint8 source) {
        (bool prngOk, bytes32 prngSeed) = _prngSeed();
        if (prngOk) return (prngSeed, SEED_PRNG);

        bytes32 pr = bytes32(block.prevrandao);
        if (pr != bytes32(0)) return (pr, SEED_PREVRANDAO);

        return (keccak256(abi.encodePacked(block.timestamp, address(this), armCount, pingCount)), SEED_FALLBACK);
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

    /// @notice Contract balance in TINYBARS, as the EVM sees it.
    function balanceTinybar() external view returns (uint256) {
        return address(this).balance;
    }
}
