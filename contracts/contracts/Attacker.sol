// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title Attacker
 * @notice An unrelated contract that tries to delete a schedule it did not create.
 *
 * Exists for one question: is the refund a contract books for itself safe from
 * everyone else? If any third party can call deleteSchedule on our booked refund,
 * the guarantee is gone — an attacker cancels it, the seller stays silent, and
 * the buyer's money sits in the hold with nothing left to release it.
 *
 * Neither function reverts on failure. We need the response CODE to tell an
 * authorisation refusal apart from a gas problem; a revert tells us neither.
 */
contract Attacker {
    address internal constant HSS = address(0x16b);

    /// @dev keccak256("deleteSchedule(address)")[0:4]
    bytes4 internal constant SEL_DELETE_SCHEDULE = 0x72d42394;
    /// @dev keccak256("deleteSchedule()")[0:4] — redirect form, on the schedule itself.
    bytes4 internal constant SEL_DELETE_REDIRECT = 0xc61dea85;

    event AttemptResult(string path, address scheduleAddress, bool callOk, int64 code, bytes returnData);

    function tryHss(address scheduleAddress) external returns (bool callOk, int64 code, bytes memory returnData) {
        (callOk, returnData) = HSS.call(abi.encodeWithSelector(SEL_DELETE_SCHEDULE, scheduleAddress));
        code = _decode(callOk, returnData);
        emit AttemptResult("attacker-contract-hss", scheduleAddress, callOk, code, returnData);
    }

    function tryRedirect(address scheduleAddress)
        external
        returns (bool callOk, int64 code, bytes memory returnData)
    {
        (callOk, returnData) = scheduleAddress.call(abi.encodeWithSelector(SEL_DELETE_REDIRECT));
        code = _decode(callOk, returnData);
        emit AttemptResult("attacker-contract-redirect", scheduleAddress, callOk, code, returnData);
    }

    /// @dev type(int64).min means no code could be decoded — a bare revert, not a refusal.
    function _decode(bool callOk, bytes memory returnData) internal pure returns (int64) {
        if (!callOk || returnData.length < 32) return type(int64).min;
        return abi.decode(returnData, (int64));
    }

    receive() external payable { }
}
