// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title ValueSink
 * @notice Recipient for the value-units spike. Records what actually arrives.
 *
 * The question is what unit `scheduleCall`'s `uint64 value` parameter is
 * denominated in. We have only ever passed zero, and session 01 already caught
 * one unit trap in this EVM (address(this).balance reads tinybars while
 * eth_getBalance reads weibars), so this gets measured rather than reasoned about.
 *
 * Records msg.value as the EVM reports it AND address(this).balance in the same
 * breath — the two are in different units on Hedera, and having both in one event
 * is what makes the arithmetic checkable afterwards.
 */
contract ValueSink {
    uint256 public landings;
    /// @notice msg.value from the most recent landing, in whatever unit the EVM reports.
    uint256 public lastMsgValue;
    /// @notice address(this).balance right after the most recent landing. TINYBARS.
    uint256 public lastBalanceTinybar;
    address public lastSender;
    bytes32 public lastTag;

    event Landed(
        bytes32 indexed tag,
        address sender,
        uint256 msgValue,
        uint256 balanceAfterTinybar,
        uint256 landings,
        uint256 blockTimestamp
    );

    /// @notice The scheduled call's target. Deliberately unrestricted, as with SpikeSchedule.ping.
    function land(bytes32 tag) external payable {
        landings += 1;
        lastMsgValue = msg.value;
        lastBalanceTinybar = address(this).balance;
        lastSender = msg.sender;
        lastTag = tag;
        emit Landed(tag, msg.sender, msg.value, address(this).balance, landings, block.timestamp);
    }

    /// @notice Balance as the EVM sees it. TINYBARS — compare against eth_getBalance, never assume.
    function balanceTinybar() external view returns (uint256) {
        return address(this).balance;
    }

    receive() external payable { }
}
