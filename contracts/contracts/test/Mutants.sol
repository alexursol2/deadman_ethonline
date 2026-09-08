// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { HoldEscrow } from "../HoldEscrow.sol";

/**
 * Deliberately broken variants of HoldEscrow, one guard removed each.
 *
 * These exist because of a rule in session 04: a test written by the author of
 * the code, against the code they wrote, tends to encode the same assumption
 * twice. The only way out is to prove the test can fail. Each mutant removes
 * exactly one guard, and the adversarial suite asserts every test goes RED here
 * before it is trusted GREEN against the real contract.
 *
 * A mutant that SURVIVES its test is reported as a failure of the test, not a
 * pass of the code.
 *
 * Never deployed. Nothing outside contracts/test/ inherits from HoldEscrow.
 */

/**
 * @notice The compare-and-set no longer checks the current status.
 * @dev Should let claim and refund both pay out on the same hold — the double
 *      payout that the state machine exists to make impossible.
 */
contract NoCasCheck is HoldEscrow {
    function _transition(uint256 holdId, Status, Status to) internal override returns (Hold storage h) {
        h = holds[holdId];
        h.status = to; // the `from` check is gone
    }
}

/**
 * @notice deleteSchedule's response code is discarded.
 * @dev The exact shape of the bug spike 4 found, and the one Hedera's own
 *      payments-scheduler template ships in one of its two cancel paths. A
 *      refused delete returns transaction SUCCESS; ignore the code and claim()
 *      pays the seller while the refund stays armed and fires anyway.
 */
contract IgnoresDeleteCode is HoldEscrow {
    function _deleteSchedule(address scheduleAddress) internal override {
        // The call is made and whatever it says is thrown away.
        (bool ok, ) = address(0x16b).call(abi.encodeWithSelector(bytes4(0x72d42394), scheduleAddress));
        ok; // silence the warning; that is the whole point
    }
}

/**
 * @notice The payout pushes and reverts on failure instead of crediting.
 * @dev Spike 8 established a scheduled execution cannot be un-fired. A revert
 *      inside refund() therefore spends the schedule and strands the hold OPEN
 *      with nothing armed — the worst state in the system.
 */
contract PushOrRevert is HoldEscrow {
    error PushFailed();

    function _payOrCredit(uint256, address to, uint64 amountTinybar) internal override {
        if (amountTinybar == 0) return;
        (bool ok, ) = to.call{ value: amountTinybar }("");
        if (!ok) revert PushFailed();
    }
}

/**
 * @notice A flat reserve floor that ignores how many refunds are armed.
 * @dev The contract pays each armed refund's gas from its own balance, so the
 *      requirement scales with openHoldCount. A fixed floor lets the Nth hold
 *      open against a balance that cannot fund N executions, and the last
 *      refunds silently fail to fire.
 */
contract FlatReserve is HoldEscrow {
    function _requiredReserveTinybar() internal view override returns (uint256) {
        return minOperatingReserveTinybar; // the per-hold term is gone
    }
}

/**
 * @notice Both the compare-and-set AND the amount-zeroing removed.
 * @dev NoCasCheck alone is NOT enough to double-pay: a second entry reads
 *      amountTinybar as 0 and pays nothing, and openHoldCount underflows. That
 *      is defence in depth and the adversarial suite found it by trying.
 *
 *      This mutant removes both, and only then does one hold pay out twice.
 *      It is what proves the pair of guards is doing the work.
 */
contract NoCasNoZero is HoldEscrow {
    function _transition(uint256 holdId, Status, Status to) internal override returns (Hold storage h) {
        h = holds[holdId];
        h.status = to;
    }

    function _consume(Hold storage h) internal override returns (uint64 amount) {
        amount = h.amountTinybar; // read, and leave everything standing
    }
}

/// @notice A payee/payer with neither receive nor fallback. Cannot be paid at all.
contract NoReceiver {
    uint256 public x;

    function poke() external {
        x += 1;
    }
}
