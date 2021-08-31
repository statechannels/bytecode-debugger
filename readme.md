# Quick Start

A sample contract can be found [here](https://github.com/statechannels/bytecode-debugger/blob/main/contracts/sample.sol)

```shell
solc  sample.sol --bin-runtime --abi -o .
npx bcdebug -b ./Sample.bin-runtime -a ./Sample.abi
```

![Simple demo](images/demo.gif)
