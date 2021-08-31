//SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.7;

contract SimpleSample {
    uint256 public total;

    function addOne() public payable {
        total = total + 1;
    }
}
