//SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.7;

contract SimpleSample {
    uint256 public aNumber;

    function add(uint256 amount) public payable {
        aNumber = aNumber + amount;
    }
}
