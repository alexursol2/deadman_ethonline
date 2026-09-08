// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title HoldEscrow
 * @notice An x402 hold that arms its own refund with the Hedera network.
 *
 * The payment settles into this contract (the x402 `payTo` is this address), and
 * the resource server then calls openHold, which books a HIP-1215 scheduled call
 * to refund() at the deadline. The seller reveals the key to claim(), which pays
 * them and deletes the schedule. If the seller does nothing, nobody does
 * anything, and the network executes the refund.
 *
 * Implements docs/plans/04-holdescrow.md. Every constraint below was measured on
 * testnet — the spike number is cited at each one. Read those before changing
 * anything here; several are counter-intuitive and two of them cost us a day.
 *
 *   C1  a network-executed call arrives with msg.sender == THIS contract,
 *       even when the target is a different contract          (spikes 1, 6)
 *   C2  block.timestamp inside a scheduled execution is the enclosing block's
 *       consensus time, NOT the expiry second                 (spike 1)
 *   C3  a rejected deleteSchedule is a SILENT NO-OP: transaction status
 *       SUCCESS, refusal only in the return code              (spike 4)
 *   C4  scheduleCall needs ~1.45M gas of its own; EIP-150 forwards 63/64  (spike 1)
 *   C5  everything inside the EVM is TINYBARS (1e8/HBAR). Never `ether`   (spike 6)
 *   C6  this contract pays execution gas from its own balance             (spike 5)
 *   C7  only this contract may delete its own schedules; admin_key is its
 *       ContractID. Not a stranger, not the deployer          (spikes 4, 5)
 *   C8  the network charges gas USED, not the limit requested             (spikes 6, 8)
 *   C10 a revert unwinds a deleteSchedule in an ordinary transaction      (spike 7)
 *   C11 a revert inside a SCHEDULED execution does NOT unwind it — the
 *       schedule is spent and cannot be re-armed              (spike 8)
 *   C12 x402 settlement cannot call a contract, and a HAPI transfer credits
 *       this contract WITHOUT running receive()               (spikes 9, 10)
 *
 * C11 is why refund() must not be able to revert after its state transition.
 * C12 is why openHold is not payable.
 */
contract HoldEscrow {
    /*//////////////////////////////////////////////////////////////
                            SYSTEM CONTRACT
    //////////////////////////////////////////////////////////////*/

    /// @dev Hedera Schedule Service, entity 0.0.363.
    address internal constant HSS = address(0x16b);

    /// @dev keccak256("scheduleCall(address,uint256,uint256,uint64,bytes)")[0:4]
    bytes4 internal constant SEL_SCHEDULE_CALL = 0x6f5bfde8;
    /// @dev keccak256("hasScheduleCapacity(uint256,uint256)")[0:4]
    bytes4 internal constant SEL_HAS_CAPACITY = 0xdfb4a999;
    /// @dev keccak256("deleteSchedule(address)")[0:4]
    bytes4 internal constant SEL_DELETE_SCHEDULE = 0x72d42394;

    /// @dev HAPI ResponseCodeEnum ordinal for SUCCESS.
    int64 internal constant HSS_SUCCESS = 22;

    /*//////////////////////////////////////////////////////////////
                              CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @dev C5. All HBAR quantities in this contract are tinybars.
    uint256 internal constant TINYBAR_PER_HBAR = 1e8;

    /**
     * @notice Gas requested for the scheduled refund call.
     * @dev Derived in plan 04 §Q7 from spike 6's measured ~132,000 for a
     *      value-carrying scheduled call, plus refund()'s own storage writes,
     *      the payout stipend and the credit-fallback branch: ~195,000 worst
     *      case, doubled for margin.
     *
     *      Rounding up is close to free (C8: the network charges gas used), and
     *      under-requesting is catastrophic (C11: the refund reverts, the
     *      schedule is spent, the hold is stranded). Asymmetric, so we round up.
     *
     *      MUST be re-measured against a real refund() before the demo.
     */
    uint256 public constant REFUND_GAS = 400_000;

    /// @dev Matches HIP-1215's reference retry pattern.
    uint256 internal constant MAX_PROBES = 8;

    /**
     * @dev Gas forwarded to a payout recipient. Bounded on purpose: a hostile or
     *      merely expensive receive() must not be able to consume the scheduled
     *      call's whole budget and take the refund down with it (C11). Enough
     *      for a simple receive, not enough to matter.
     */
    uint256 internal constant PAYOUT_STIPEND = 30_000;

    /// @notice How long past the deadline before anyone may rescue a stuck hold.
    uint256 public constant RESCUE_GRACE = 24 hours;

    /// @dev Below ~1s the network rejects the expiry outright, and
    ///      hasScheduleCapacity(now + 1) already returns false (spike 1).
    uint64 public constant MIN_DELAY_SECONDS = 30;
    uint64 public constant MAX_DELAY_SECONDS = 7 days;

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    /// @dev NONE = 0, so an untouched slot is NONE and a fresh id is always free.
    enum Status {
        NONE,
        OPEN,
        CLAIMED,
        REFUNDED
    }

    struct Hold {
        // ── slot 0: 17 bytes ──
        Status status;
        uint64 deadline; // the second the refund is actually armed for
        uint64 amountTinybar;
        // ── ──
        address payer;
        address payee;
        address scheduleAddress; // returned by scheduleCall; needed to delete it
        bytes32 hKey; // the ONLY commitment this contract checks
        bytes32 hRequest; // also the replay key
    }

    /// @notice Arguments to openHold, as a struct to keep the stack shallow.
    struct OpenParams {
        address payer;
        address payee;
        uint64 amountTinybar;
        uint64 deadline;
        bytes32 hKey; // H(k)        checked on-chain by claim()
        bytes32 hCipher; // H(C)        emitted only — buyer's evidence
        bytes32 hPlain; // H(m)        emitted only — buyer's evidence
        bytes32 hRequest; // H(request)  stored, blocks replay
    }

    /// @dev Starts at 1 so that 0 means "absent" in holdByRequest.
    uint256 public nextHoldId = 1;
    mapping(uint256 => Hold) public holds;
    /// @notice H(request) -> holdId. Blocks a seller replaying one result for a new request.
    mapping(bytes32 => uint256) public holdByRequest;
    /// @notice Pull-payment credits, in tinybars.
    mapping(address => uint256) public withdrawableTinybar;

    /// @notice Sum of amounts across OPEN holds.
    uint256 public totalLockedTinybar;
    /// @notice How many holds are OPEN, i.e. how many refunds are armed and
    ///         waiting for this contract to pay their execution gas (C6).
    uint256 public openHoldCount;
    /// @notice Sum of credited-but-unwithdrawn balances.
    uint256 public totalWithdrawableTinybar;

    address public owner;
    /// @notice Who may open holds. On by default — see plan 04 §Q6 and §8.1.
    bool public allowlistEnabled = true;
    mapping(address => bool) public isOpener;

    /// @notice Headroom each hold must leave to pay for its own refund execution.
    uint64 public refundGasDepositTinybar = 50_000_000; // 0.5 HBAR
    /// @notice Floor of free balance after opening a hold, so armed refunds can run.
    uint64 public minOperatingReserveTinybar = 500_000_000; // 5 HBAR
    /// @notice Smallest hold worth arming. Stops dust griefing.
    uint64 public minHoldTinybar = 1_000_000; // 0.01 HBAR

    uint256 private _lock = 1;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event HoldOpened(
        uint256 indexed holdId,
        address indexed payer,
        address indexed payee,
        uint64 amountTinybar,
        uint64 requestedDeadline,
        uint64 armedDeadline,
        address scheduleAddress,
        uint8 probesUsed,
        bytes32 hKey,
        bytes32 hCipher,
        bytes32 hPlain,
        bytes32 hRequest
    );

    /// @dev `k` in the log is how the buyer decrypts WITHOUT having to act.
    event Claimed(uint256 indexed holdId, address indexed payee, bytes32 k);
    event Refunded(uint256 indexed holdId, address indexed payer, uint64 amountTinybar);
    event Rescued(uint256 indexed holdId, address indexed payer, uint64 amountTinybar);
    event PaidOut(uint256 indexed holdId, address indexed to, uint64 amountTinybar);
    /// @dev The push failed and the amount was credited instead. Never a revert (C11).
    event PayoutDeferred(uint256 indexed holdId, address indexed to, uint64 amountTinybar);
    event Withdrawn(address indexed to, uint256 amountTinybar);
    event Funded(address indexed from, uint256 amountTinybar);
    event OrphanAttributed(address indexed to, uint256 amountTinybar, string reason);
    event OpenerSet(address indexed opener, bool allowed);
    event AllowlistEnabledSet(bool enabled);
    event ConfigSet(uint64 refundGasDeposit, uint64 minOperatingReserve, uint64 minHold);
    event ReserveSwept(address indexed to, uint256 amountTinybar);
    event OwnerSet(address indexed newOwner);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotOwner();
    error NotAnOpener(address caller);
    error Reentrancy();
    error ZeroAddress();
    error HoldTooSmall(uint64 amountTinybar, uint64 minimum);
    error DeadlineOutOfRange(uint64 deadline, uint64 earliest, uint64 latest);
    error ZeroCommitment();
    error RequestAlreadyHeld(bytes32 hRequest, uint256 existingHoldId);
    error Underfunded(uint256 unattributed, uint256 required);
    error Insolvent(uint256 freeAfter, uint256 required);
    error BadState(uint256 holdId, Status actual, Status expected);
    error BadKey(uint256 holdId);
    error NotTheNetwork(address caller);
    error StaleSchedule(uint256 holdId, uint64 got, uint64 stored);
    error TooEarlyToRescue(uint256 holdId, uint64 notBefore);
    error NothingToWithdraw();
    error WithdrawFailed();
    error WouldBreakSolvency(uint256 requested, uint256 available);
    error NoUnsaturatedSecond(uint64 requestedSecond);
    error HssCallReverted(string fn, bytes returnData);
    error HssMalformedReturn(string fn, bytes returnData);
    error HssNotSuccess(string fn, int64 code);
    error HssZeroScheduleAddress(int64 code);

    /*//////////////////////////////////////////////////////////////
                              MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * @dev A plain mutex, not a self-call check. refund() is entered with
     *      msg.sender == address(this) (C1) and that is NOT reentrancy — it is a
     *      separate transaction submitted by the network.
     */
    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor() {
        owner = msg.sender;
        isOpener[msg.sender] = true;
        emit OwnerSet(msg.sender);
        emit OpenerSet(msg.sender, true);
    }

    /*//////////////////////////////////////////////////////////////
                              OPEN A HOLD
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Arm a refund against funds already credited to this contract.
     *
     * @dev NOT payable, and that is not an oversight (C12). The x402 settlement
     *      is a HAPI CryptoTransfer: it cannot call a contract, and crediting
     *      this contract does not run receive(). So the money is already here by
     *      the time this is called, and openHold attributes it rather than
     *      receiving it.
     *
     *      The window between settlement and arming is real and disclosed in the
     *      README. What bounds it: claim() is the only path to the payee, so a
     *      server that settles and skips this call gets nothing, and the funds
     *      stay here out of its reach.
     */
    function openHold(OpenParams calldata p) external nonReentrant returns (uint256 holdId) {
        if (allowlistEnabled && !isOpener[msg.sender]) revert NotAnOpener(msg.sender);
        if (p.payer == address(0) || p.payee == address(0)) revert ZeroAddress();
        if (p.amountTinybar < minHoldTinybar) revert HoldTooSmall(p.amountTinybar, minHoldTinybar);
        if (p.hKey == bytes32(0) || p.hRequest == bytes32(0)) revert ZeroCommitment();

        uint64 earliest = uint64(block.timestamp) + MIN_DELAY_SECONDS;
        uint64 latest = uint64(block.timestamp) + MAX_DELAY_SECONDS;
        if (p.deadline < earliest || p.deadline > latest) {
            revert DeadlineOutOfRange(p.deadline, earliest, latest);
        }

        uint256 existing = holdByRequest[p.hRequest];
        if (existing != 0) revert RequestAlreadyHeld(p.hRequest, existing);

        // The payment must already be here, with headroom for its own refund gas.
        uint256 unattributed = _unattributedTinybar();
        uint256 required = uint256(p.amountTinybar) + uint256(refundGasDepositTinybar);
        if (unattributed < required) revert Underfunded(unattributed, required);

        holdId = nextHoldId++;

        // ── effects, before any external call ──
        Hold storage h = holds[holdId];
        h.status = Status.OPEN;
        h.amountTinybar = p.amountTinybar;
        h.payer = p.payer;
        h.payee = p.payee;
        h.hKey = p.hKey;
        h.hRequest = p.hRequest;
        holdByRequest[p.hRequest] = holdId;
        totalLockedTinybar += p.amountTinybar;
        openHoldCount += 1;

        // Solvency: after locking this hold, is there still enough free balance
        // to execute EVERY refund we have promised? (C6)
        uint256 freeAfter = _freeTinybar();
        uint256 needed = _requiredReserveTinybar();
        if (freeAfter < needed) revert Insolvent(freeAfter, needed);

        // ── arm the refund; anything short of code 22 reverts the whole thing ──
        (uint64 armedDeadline, uint8 probesUsed, address scheduleAddress) = _armRefund(holdId, p.deadline);
        h.deadline = armedDeadline;
        h.scheduleAddress = scheduleAddress;

        _emitOpened(holdId, p, armedDeadline, scheduleAddress, probesUsed);
    }

    /**
     * @dev The emit lives in its own frame purely to keep openHold off the stack
     *      limit. HoldOpened carries twelve fields — all four commitments among
     *      them — and inlining it puts openHold over the top.
     *
     *      hCipher and hPlain appear ONLY here, never in storage. Plan 04 §9.1:
     *      the contract cannot check them, they exist so a cheated buyer can
     *      prove which element the seller lied about, and a log entry is as
     *      on-chain as a storage slot for that purpose at a tenth of the cost.
     *      hKey and hRequest are stored because claim() and the replay guard
     *      actually read them.
     */
    function _emitOpened(
        uint256 holdId,
        OpenParams calldata p,
        uint64 armedDeadline,
        address scheduleAddress,
        uint8 probesUsed
    ) internal {
        emit HoldOpened(
            holdId,
            p.payer,
            p.payee,
            p.amountTinybar,
            p.deadline,
            armedDeadline,
            scheduleAddress,
            probesUsed,
            p.hKey,
            p.hCipher,
            p.hPlain,
            p.hRequest
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 CLAIM
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Reveal the key, get paid, cancel the booked refund.
     *
     * @dev Callable by anyone holding `k`. The payee is read from storage, not
     *      from msg.sender, so who submits it does not matter.
     *
     *      No block.timestamp gate, deliberately. The schedule's deletability IS
     *      the deadline; a local timestamp check would be a second arbiter that
     *      could disagree with the network. See plan 04 §Q2.
     */
    function claim(uint256 holdId, bytes32 k) external nonReentrant {
        Hold storage h = _transition(holdId, Status.OPEN, Status.CLAIMED);
        if (keccak256(abi.encodePacked(k)) != h.hKey) revert BadKey(holdId);

        uint64 amount = h.amountTinybar;
        address payee = h.payee;
        address scheduleAddress = h.scheduleAddress;

        h.amountTinybar = 0;
        totalLockedTinybar -= amount;
        openHoldCount -= 1;

        // C3: a refused delete returns a CODE, it does not revert. Discarding it
        // would pay the seller AND let the refund fire — the hold pays out twice.
        // Reverting here is safe: C10 says the delete unwinds with the
        // transaction, and the refund stays armed.
        _deleteSchedule(scheduleAddress);

        _payOrCredit(holdId, payee, amount);
        emit Claimed(holdId, payee, k);
    }

    /*//////////////////////////////////////////////////////////////
                                REFUND
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Executed by the Hedera network at the deadline. Nobody calls this.
     *
     * @dev NOTHING HERE MAY REVERT AFTER THE STATE TRANSITION. C11: a revert
     *      inside a scheduled execution does not un-fire it. The schedule is
     *      spent, there is no second one, and the hold would be stranded.
     *
     *      Every check that can fail is before the transition. After it: only
     *      arithmetic, a gas-bounded push, and events.
     *
     *      `deadline` travels in the calldata because block.timestamp in here is
     *      the enclosing block's time, not the expiry second (C2), so it cannot
     *      identify which deadline fired.
     */
    function refund(uint256 holdId, uint64 deadline) external nonReentrant {
        // C1: a network-executed call arrives as THIS contract. A schedule armed
        // by somebody else's contract arrives as theirs and is rejected here.
        if (msg.sender != address(this)) revert NotTheNetwork(msg.sender);

        Hold storage h = holds[holdId];
        if (h.deadline != deadline) revert StaleSchedule(holdId, deadline, h.deadline);

        _transition(holdId, Status.OPEN, Status.REFUNDED);

        uint64 amount = h.amountTinybar;
        address payer = h.payer;
        h.amountTinybar = 0;
        totalLockedTinybar -= amount;
        openHoldCount -= 1;

        _payOrCredit(holdId, payer, amount);
        emit Refunded(holdId, payer, amount);
    }

    /**
     * @notice Backstop for a hold whose scheduled refund never landed.
     *
     * @dev Should be unreachable. It exists because C11 makes a stranded hold
     *      possible if refund() ever reverts wholesale — a gas budget we got
     *      wrong, or a services change. Credits rather than pushes, so it cannot
     *      fail for the same reason the thing it is rescuing failed.
     *
     *      This IS a "someone must act" path and it is disclosed in the README.
     *      A stuck hold is worse than an honest backstop.
     */
    function rescue(uint256 holdId) external nonReentrant {
        Hold storage h = holds[holdId];
        uint64 notBefore = h.deadline + uint64(RESCUE_GRACE);
        if (block.timestamp < notBefore) revert TooEarlyToRescue(holdId, notBefore);

        _transition(holdId, Status.OPEN, Status.REFUNDED);

        uint64 amount = h.amountTinybar;
        address payer = h.payer;
        h.amountTinybar = 0;
        totalLockedTinybar -= amount;
        openHoldCount -= 1;

        withdrawableTinybar[payer] += amount;
        totalWithdrawableTinybar += amount;
        emit Rescued(holdId, payer, amount);
    }

    /*//////////////////////////////////////////////////////////////
                               PAYOUTS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev The only payout primitive. MUST NOT REVERT — see refund().
     *
     *      `value` is in tinybars: the EVM's own unit on Hedera, the same one
     *      address(this).balance and msg.value use (C5, spike 6).
     */
    function _payOrCredit(uint256 holdId, address to, uint64 amountTinybar) internal {
        if (amountTinybar == 0) return;
        (bool ok, ) = to.call{ value: amountTinybar, gas: PAYOUT_STIPEND }("");
        if (ok) {
            emit PaidOut(holdId, to, amountTinybar);
        } else {
            withdrawableTinybar[to] += amountTinybar;
            totalWithdrawableTinybar += amountTinybar;
            emit PayoutDeferred(holdId, to, amountTinybar);
        }
    }

    /**
     * @notice Collect a deferred payout.
     * @dev Reverting is safe here — nothing has been consumed — so this forwards
     *      all remaining gas rather than the bounded stipend. A recipient that
     *      needs real gas to accept funds can get it, and a failure simply
     *      leaves the credit in place to try again.
     */
    function withdraw() external nonReentrant {
        uint256 amount = withdrawableTinybar[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        withdrawableTinybar[msg.sender] = 0;
        totalWithdrawableTinybar -= amount;

        (bool ok, ) = msg.sender.call{ value: amount }("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                          SCHEDULE SERVICE
    //////////////////////////////////////////////////////////////*/

    function _armRefund(uint256 holdId, uint64 requestedDeadline)
        internal
        returns (uint64 armedDeadline, uint8 probesUsed, address scheduleAddress)
    {
        (uint256 second, uint8 probes) = _findAvailableSecond(requestedDeadline);
        armedDeadline = uint64(second);
        probesUsed = probes;

        bytes memory callData = abi.encodeWithSelector(this.refund.selector, holdId, armedDeadline);

        (bool callOk, bytes memory ret) = HSS.call(
            abi.encodeWithSelector(
                SEL_SCHEDULE_CALL,
                address(this),
                uint256(armedDeadline),
                REFUND_GAS,
                uint64(0), // no value on the scheduled call; refund() moves the money itself
                callData
            )
        );

        // C4: starved of gas this reverts with EMPTY returndata rather than
        // returning a code, so both shapes have to be handled.
        if (!callOk) revert HssCallReverted("scheduleCall", ret);
        if (ret.length < 64) revert HssMalformedReturn("scheduleCall", ret);

        int64 code;
        (code, scheduleAddress) = abi.decode(ret, (int64, address));

        // BOTH halves. A saturated second returns a zero address with a non-22
        // code and does not revert; checking only one lets it through.
        if (code != HSS_SUCCESS) revert HssNotSuccess("scheduleCall", code);
        if (scheduleAddress == address(0)) revert HssZeroScheduleAddress(code);
    }

    /// @dev Reverts unless the delete was ACCEPTED. C3.
    function _deleteSchedule(address scheduleAddress) internal {
        (bool callOk, bytes memory ret) =
            HSS.call(abi.encodeWithSelector(SEL_DELETE_SCHEDULE, scheduleAddress));
        if (!callOk) revert HssCallReverted("deleteSchedule", ret);
        if (ret.length < 32) revert HssMalformedReturn("deleteSchedule", ret);
        int64 code = abi.decode(ret, (int64));
        if (code != HSS_SUCCESS) revert HssNotSuccess("deleteSchedule", code);
    }

    /**
     * @dev HIP-1215's own retry pattern — exponential backoff with jitter so
     *      contracts probing the same ideal second scatter instead of stampeding
     *      — plus a minute-boundary skip, since scheduled work clusters there.
     *
     *      Seeded from block.prevrandao. Spike 1 measured prevrandao and the
     *      HIP-351 PRNG at 0x169 returning IDENTICAL values on Hedera, so this
     *      is the same entropy without the system-contract call.
     *
     *      UNTESTED AGAINST A SATURATED NETWORK. Testnet is uncongested and
     *      probesUsed has been 0 on every run to date. Covered only by unit
     *      tests against a mocked HSS. Stated in the README.
     */
    function _findAvailableSecond(uint64 requestedSecond)
        internal
        view
        returns (uint256 second, uint8 probesUsed)
    {
        if (_secondUsable(requestedSecond)) return (requestedSecond, 0);

        bytes32 seed = bytes32(block.prevrandao);
        for (uint256 i = 0; i < MAX_PROBES; ++i) {
            uint256 baseDelay = 1 << i; // 1, 2, 4, 8, ...
            uint256 jitter = uint256(uint16(uint256(keccak256(abi.encodePacked(seed, i))))) % baseDelay;
            uint256 candidate = uint256(requestedSecond) + baseDelay + jitter;
            if (_secondUsable(candidate)) return (candidate, uint8(i + 1));
        }
        revert NoUnsaturatedSecond(requestedSecond);
    }

    function _secondUsable(uint256 candidate) internal view returns (bool) {
        if (candidate % 60 == 0) return false;
        return _hasCapacity(candidate);
    }

    /**
     * @dev Returns false for an INVALID expiry as well as a saturated one — the
     *      two are indistinguishable through this interface (spike 1), so a
     *      false here is not evidence of congestion.
     */
    function _hasCapacity(uint256 expirySecond) internal view returns (bool) {
        (bool callOk, bytes memory ret) =
            HSS.staticcall(abi.encodeWithSelector(SEL_HAS_CAPACITY, expirySecond, REFUND_GAS));
        if (!callOk || ret.length < 32) return false;
        return abi.decode(ret, (bool));
    }

    /*//////////////////////////////////////////////////////////////
                             STATE MACHINE
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev The single compare-and-set. Nothing else in this contract writes
     *      `status`, and the write happens before any external call, so a
     *      reentrant caller re-reads it and fails here.
     *
     *      OPEN is only ever written by openHold, to a fresh monotonic id, so
     *      CLAIMED and REFUNDED are terminal by construction rather than by
     *      convention.
     */
    function _transition(uint256 holdId, Status from, Status to) internal returns (Hold storage h) {
        h = holds[holdId];
        if (h.status != from) revert BadState(holdId, h.status, from);
        h.status = to;
    }

    /*//////////////////////////////////////////////////////////////
                              ACCOUNTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Balance not spoken for by an open hold or a pending withdrawal. Tinybars.
    function _freeTinybar() internal view returns (uint256) {
        uint256 bal = address(this).balance; // C5: tinybars
        uint256 spokenFor = totalLockedTinybar + totalWithdrawableTinybar;
        return bal > spokenFor ? bal - spokenFor : 0;
    }

    /**
     * @notice Free balance this contract must keep to honour what it has armed.
     *
     * @dev A FLAT floor would be wrong. The contract pays each scheduled refund's
     *      gas from its own balance (C6), so the requirement scales with how many
     *      refunds are armed: 100 open holds need 100 executions' worth of gas,
     *      and a fixed 5 HBAR would let the hundredth refund silently fail to
     *      fire — the brief's failure mode 3, arriving through the accounting.
     *
     *      refundGasDeposit is calibrated from measurement: spike 6 saw 0.1389
     *      HBAR for a value-carrying scheduled execution, spike 8 saw 0.1178 for
     *      a plain one. 0.5 HBAR is ~3.5x the worst observed.
     */
    function _requiredReserveTinybar() internal view returns (uint256) {
        return uint256(minOperatingReserveTinybar) + openHoldCount * uint256(refundGasDepositTinybar);
    }

    function requiredReserveTinybar() external view returns (uint256) {
        return _requiredReserveTinybar();
    }

    /// @notice Settled-but-unarmed payments plus the operating float. Tinybars.
    function _unattributedTinybar() internal view returns (uint256) {
        return _freeTinybar();
    }

    function unattributedTinybar() external view returns (uint256) {
        return _unattributedTinybar();
    }

    function freeTinybar() external view returns (uint256) {
        return _freeTinybar();
    }

    /// @notice Balance as the EVM sees it. TINYBARS, not weibars (C5).
    function balanceTinybar() external view returns (uint256) {
        return address(this).balance;
    }

    function getHold(uint256 holdId) external view returns (Hold memory) {
        return holds[holdId];
    }

    /*//////////////////////////////////////////////////////////////
                                FUNDING
    //////////////////////////////////////////////////////////////*/

    /// @notice Top up the operating float that pays for scheduled refund gas (C6).
    function fund() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /**
     * @dev Bare EVM transfers are accepted. Note that the x402 settlement does
     *      NOT come through here — a HAPI CryptoTransfer credits the balance
     *      without executing anything (C12) — so this cannot be used to detect
     *      an incoming payment. That is why openHold attributes rather than
     *      receives.
     */
    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /*//////////////////////////////////////////////////////////////
                            ADMINISTRATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Attribute a settled payment that never got a hold, back to its payer.
     *
     * @dev The disclosed recovery path for the settle-then-arm window (C12). A
     *      payment that is never armed leaves no on-chain record of who sent it —
     *      this contract sees a balance, not a payer — so attribution is
     *      necessarily manual and off-chain-evidenced. Credits rather than
     *      pushes, and cannot touch funds that back an open hold.
     */
    function attributeOrphanedPayment(address to, uint256 amountTinybar, string calldata reason)
        external
        onlyOwner
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        // Orphaned funds are part of the free balance, so attributing them must
        // not eat the reserve that armed refunds depend on.
        uint256 free = _freeTinybar();
        uint256 needed = amountTinybar + _requiredReserveTinybar();
        if (needed > free) revert WouldBreakSolvency(needed, free);

        withdrawableTinybar[to] += amountTinybar;
        totalWithdrawableTinybar += amountTinybar;
        emit OrphanAttributed(to, amountTinybar, reason);
    }

    /**
     * @notice Withdraw operating float.
     * @dev Re-asserts solvency. An owner who could drain below
     *      totalLocked + totalWithdrawable is a rug; this is the assertion that
     *      says they cannot.
     */
    function sweepReserve(address to, uint256 amountTinybar) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 free = _freeTinybar();
        uint256 needed = amountTinybar + _requiredReserveTinybar();
        if (needed > free) revert WouldBreakSolvency(needed, free);
        (bool ok, ) = to.call{ value: amountTinybar }("");
        if (!ok) revert WithdrawFailed();
        emit ReserveSwept(to, amountTinybar);
    }

    function setOpener(address opener, bool allowed) external onlyOwner {
        isOpener[opener] = allowed;
        emit OpenerSet(opener, allowed);
    }

    /**
     * @dev Turning the allowlist off is load-bearing, not cosmetic: without it a
     *      hostile opener can arm a hold against another buyer's unattributed
     *      balance, because settled funds carry no payer identity (C12).
     *      Do not disable until attribution is solved.
     */
    function setAllowlistEnabled(bool enabled) external onlyOwner {
        allowlistEnabled = enabled;
        emit AllowlistEnabledSet(enabled);
    }

    function setConfig(uint64 refundGasDeposit, uint64 minOperatingReserve, uint64 minHold)
        external
        onlyOwner
    {
        refundGasDepositTinybar = refundGasDeposit;
        minOperatingReserveTinybar = minOperatingReserve;
        minHoldTinybar = minHold;
        emit ConfigSet(refundGasDeposit, minOperatingReserve, minHold);
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
        emit OwnerSet(newOwner);
    }
}
