# EVM Bytecode Debugger

This utility allows you to take bytecode and abi output from `solc` and step through the byte code.

## Quick Start

```shell
# Download the sample contract from github
curl https://rawcdn.githack.com/statechannels/bytecode-debugger/836be299d2a9977fd78ca132dbb73a24090007cd/contracts/sample.sol -o ./sample.sol
# Build the bytecode and abi from the contract
solc  sample.sol --bin-runtime --abi -o .
# Debug the bytecode
npx bytecode-debugger -b ./Sample.bin-runtime -a ./Sample.abi
```

![Simple demo](https://github.com/statechannels/bytecode-debugger/blob/main/images/demo.gif?raw=true)
