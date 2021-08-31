//SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.7;

contract Sample {
    uint256 public total;

    function add(uint256 amountToAdd) public payable {
        total = total + amountToAdd;
    }
}
