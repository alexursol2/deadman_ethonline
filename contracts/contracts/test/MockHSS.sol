// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title MockHSS
 * @notice Stand-in for the Hedera Schedule Service at 0x16b, for unit tests.
 *
 * Placed at 0x16b with hardhat_setCode so HoldEscrow's hard-coded address hits
 * it. Storage starts empty there, so every knob has a setter.
 *
 * It exists mainly to reach paths the real network will not give us:
 *
 *   - the capacity/jitter fallback, which has never executed on testnet because
 *     testnet is uncongested (probesUsed has been 0 on every run to date)
 *   - a saturated second returning a ZERO ADDRESS with a non-22 code, which is
 *     the failure HIP-1215 documents and which never happens in practice
 *   - a REFUSED deleteSchedule, which on the real network is a silent no-op and
 *     is the difference between paying once and paying twice
 *
 * This mock does NOT reproduce Hedera's unit semantics — on a local EVM,
 * balances are wei. The tinybar behaviour is only ever exercised on testnet.
 *
 * IMPORTANT: hardhat_setCode plants runtime code but does NOT run a
 * constructor, so storage here starts as all zeros and no field initialiser
 * ever executes. Every default is therefore expressed as "0 means healthy"
 * rather than as an initialiser, so a freshly planted mock behaves like a
 * working Schedule Service without any setup call.
 */
contract MockHSS {
    /// @dev Seconds for which hasScheduleCapacity returns false.
    mapping(uint256 => bool) public saturated;
    /// @dev If set, every second strictly below this is saturated.
    uint256 public saturatedBelow;

    /// @dev Response code for scheduleCall. ZERO means "unset", i.e. return 22.
    int64 public scheduleCallCodeOverride;
    /// @dev Force a zero schedule address, as a saturated second does.
    bool public returnZeroAddress;

    /// @dev Response code for deleteSchedule. ZERO means "unset", i.e. return 22.
    int64 public deleteCodeOverride;
    /// @dev Make deleteSchedule revert outright rather than return a code.
    bool public deleteReverts;

    uint256 public scheduleSeq;
    uint256 public scheduleCallCount;
    uint256 public deleteCount;

    // Last call, so tests can assert what the escrow actually asked for.
    address public lastTo;
    uint256 public lastExpirySecond;
    uint256 public lastGasLimit;
    uint64 public lastValue;
    bytes public lastCallData;
    address public lastDeleted;

    function setSaturated(uint256 second, bool v) external {
        saturated[second] = v;
    }

    function setSaturatedBelow(uint256 second) external {
        saturatedBelow = second;
    }

    function setScheduleCallCode(int64 code) external {
        scheduleCallCodeOverride = code;
    }

    function setReturnZeroAddress(bool v) external {
        returnZeroAddress = v;
    }

    function setDeleteCode(int64 code) external {
        deleteCodeOverride = code;
    }

    function setDeleteReverts(bool v) external {
        deleteReverts = v;
    }

    function hasScheduleCapacity(uint256 expirySecond, uint256) external view returns (bool) {
        if (saturated[expirySecond]) return false;
        if (expirySecond < saturatedBelow) return false;
        return true;
    }

    function scheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes memory callData
    ) external returns (int64, address) {
        scheduleCallCount += 1;
        lastTo = to;
        lastExpirySecond = expirySecond;
        lastGasLimit = gasLimit;
        lastValue = value;
        lastCallData = callData;

        int64 code = scheduleCallCodeOverride == 0 ? int64(22) : scheduleCallCodeOverride;
        if (code != 22 || returnZeroAddress) {
            // Exactly how a saturated second behaves: a code and a zero address,
            // with NO revert. The trap HoldEscrow has to catch.
            return (code, address(0));
        }
        scheduleSeq += 1;
        return (22, address(uint160(0x5c4e0000 + scheduleSeq)));
    }

    function deleteSchedule(address scheduleAddress) external returns (int64) {
        deleteCount += 1;
        lastDeleted = scheduleAddress;
        if (deleteReverts) revert("mock: delete reverted");
        return deleteCodeOverride == 0 ? int64(22) : deleteCodeOverride;
    }
}

/// @notice A payee that refuses payment, to exercise the credit-on-failure path.
contract RejectingRecipient {
    receive() external payable {
        revert("nope");
    }
}

/// @notice A payee whose receive() burns everything it is given.
contract GasBurningRecipient {
    uint256 public sink;

    receive() external payable {
        while (true) {
            sink += 1;
        }
    }
}
