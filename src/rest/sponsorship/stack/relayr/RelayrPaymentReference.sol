// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.26;

// Independent reconstruction for bytecode comparison, not claimed upstream source.
contract RelayrPaymentReference {
    error deadlineExceeded(bytes16 payment_uuid, uint40 deadline, uint40 current_time);
    event Prepayment(bytes16 indexed payment_uuid, uint256 amount, uint40 deadline);
    function prepayment(bytes16 payment_uuid, uint40 deadline) external payable {
        if (block.timestamp > deadline) {
            revert deadlineExceeded(payment_uuid, deadline, uint40(block.timestamp));
        }
        payable(address(0x755ff2f75A0A586ecfa2B9A3c959CB662458a105)).transfer(msg.value);
        emit Prepayment(payment_uuid, msg.value, deadline);
    }
}
