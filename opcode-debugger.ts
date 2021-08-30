import { handlers } from "@ethereumjs/vm/dist/evm/opcodes/functions";
import { RunState } from "@ethereumjs/vm/dist/evm/interpreter";
import Memory from "@ethereumjs/vm/dist/evm/memory";
import { DefaultStateManager } from "@ethereumjs/vm/dist/state";
import { Address, BN } from "ethereumjs-util";
import Stack from "@ethereumjs/vm/dist/evm/stack";
import EEI from "@ethereumjs/vm/dist/evm/eei";
import Common, { Chain } from "@ethereumjs/common";
import {
  AsyncOpHandler,
  getOpcodesForHF,
  Opcode,
  OpcodeList,
} from "@ethereumjs/vm/dist/evm/opcodes";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import EVM from "@ethereumjs/vm/dist/evm/evm";
import { Block } from "@ethereumjs/block";

import { AsyncLineReader } from "async-line-reader";
import Table from "cli-table";
import chalk from "chalk";
import _ from "lodash";
import { SecureTrie as Trie } from "merkle-patricia-tree";
import level from "level";

const LINE_HEIGHT = 15;
const START_GAS = 15000000;

debugOpcode();

async function debugOpcode() {
  // TODO: Point these to files
  const commandArguments = await yargs(hideBin(process.argv))
    .option("b", {
      alias: "bytecode",
      demandOption: true,
      type: "string",
    })

    .option("c", { alias: "calldata", type: "string", default: "a2e62045" })
    .option("v", { alias: "callvalue", type: "string", default: "0" }).argv;
  await runCode(
    Buffer.from(commandArguments.b, "hex"),
    Buffer.from(commandArguments.c, "hex"),
    new BN(commandArguments.v, "hex")
  );
}

async function runCode(code: Buffer, callData: Buffer, callValue: BN) {
  const reader = new AsyncLineReader(process.stdin);

  const { runState, opCodeList, common } = evmSetup(callData, callValue, code);

  // TODO: This is a hack to ensure the call to getContractStorage doesn't fail
  // TODO: There is probably a proper way of doing this
  await runState.stateManager.putContractStorage(
    Address.zero(),
    Buffer.from(_.repeat("deadbeaf", 8), "hex"),
    Buffer.from(_.repeat("deadbeaf", 8), "hex")
  );

  while (runState.programCounter < runState.code.length) {
    await reader.readLine();

    const runStateOutput = await generateRunStateOutput(runState, LINE_HEIGHT);
    const instructionTable = await generateInstructionTable(
      runState.programCounter,
      runState.code,
      LINE_HEIGHT,
      opCodeList
    );
    const masterTable = new Table();
    masterTable.push([instructionTable.toString(), runStateOutput.toString()]);

    const bytecodeOutput = generateBytecodeOutput(
      runState.code,
      runState.programCounter,
      opCodeList
    );

    console.clear();
    console.log(chalk.bold("CALL DATA"));
    console.log(`0x${runState.eei.getCallData().toString("hex")}`);
    console.log(chalk.bold("CALL VALUE"));
    console.log(`0x${runState.eei.getCallValue().toString("hex")}`);

    console.log(bytecodeOutput);
    console.log(masterTable.toString());

    await executeStep(runState, opCodeList, common);
  }
}

function evmSetup(
  callData: Buffer,
  callValue: BN,
  code: Buffer
): { runState: RunState; opCodeList: OpcodeList; common: Common } {
  const common = new Common({ chain: Chain.Mainnet });
  const db = level("temp");

  const trie = new Trie(db);
  const stateManager = new DefaultStateManager({ common, trie });

  const env = {
    blockchain: undefined!, // TODO: What's this used for?
    address: Address.zero(),
    caller: Address.zero(),
    callData,
    callValue,
    code,
    isStatic: false,
    depth: 0,
    gasPrice: new BN(1),
    origin: Address.zero(),
    block: new Block(),
    contract: undefined!, // TODO Sort this out
    codeAddress: Address.zero(),
  };
  const eei = new EEI(
    env,
    stateManager,
    { _vm: { DEBUG: true } } as EVM, // TODO: Hacky AF
    common,
    new BN(START_GAS) // TODO: Just grabbed this from a quick google, this should probably be a param with a sane default
  );

  const opCodeList = getOpcodesForHF(common);

  const { validJumpSubs, validJumps } = getValidJumpDests(code, opCodeList);

  const runState: RunState = {
    programCounter: 0,
    opCode: code[0],

    memory: new Memory(),
    memoryWordCount: new BN(0),
    highestMemCost: new BN(0),
    stack: new Stack(),
    returnStack: new Stack(1023), //  EIP 2315 spec
    code,
    validJumps,
    validJumpSubs,
    stateManager,
    eei,
  };

  return { opCodeList, runState, common };
}

async function generateStorageLine(
  lineCounter: number,
  runState: RunState
): Promise<string[]> {
  const storageDump = await runState.stateManager.dumpStorage(Address.zero());

  const storageItems = Object.keys(storageDump)
    .filter((key) => !storageDump[key].includes("deadbeaf"))
    .map((key) => [key, storageDump[key]]);

  if (lineCounter < storageItems.length) {
    return storageItems[lineCounter];
  } else {
    return ["", ""];
  }
}

function generateStackline(lineCounter: number, runState: RunState) {
  const line: string[] = [];
  const stackItems = _.clone(runState.stack._store)
    .map((bn) => `0x${bn.toString("hex")}`)
    .reverse();
  if (lineCounter < stackItems.length) {
    line.push(stackItems[lineCounter]);
  } else {
    line.push("");
  }
  return line;
}

function generateMemoryLine(lineCounter: number, runState: RunState) {
  const line: string[] = [];

  // TODO: Just calculate the iterator and copy the value
  const memoryItems = _.clone(runState.memory._store).reverse();

  if (lineCounter < memoryItems.length) {
    line.push(
      memoryItems[lineCounter] === 0
        ? ""
        : toPrettyHex(memoryItems[lineCounter])
    );
  } else {
    line.push("");
  }
  return line;
}

async function generateInstructionTable(
  currentCounter: number,
  code: Buffer,
  height: number,
  opCodeList: OpcodeList
): Promise<string> {
  const opCodeExecTable = new Table({
    head: ["PC", "INSTRUCTION", "GAS COST"],
    colWidths: [10, 30, 10],
  });

  const numberOfLines = Math.min(height, code.length - currentCounter);

  let printCounter = currentCounter;

  for (let i = 0; i < numberOfLines; i++) {
    const color = printCounter === currentCounter ? chalk.bgBlue : chalk.white;
    const opcodeInfo = getOpcodeInfo(code[printCounter], opCodeList);
    opCodeExecTable.push([
      color(toPrettyHex(printCounter)),
      color(opcodeInfo.fullName),
      color(toPrettyHex(opcodeInfo.fee)),
    ]);

    printCounter = incrementCounter(printCounter, code, opCodeList);
  }
  return opCodeExecTable.toString();
}

function generateBytecodeOutput(
  code: Buffer,
  currentCounter: number,
  opCodeList: OpcodeList
): string {
  let byteCodeOutput = "0x";

  let printCounter = 0;

  while (printCounter < code.length) {
    if (currentCounter === printCounter) {
      const opCode = opCodeList.get(code[printCounter])!;
      let numToPush = opCode.name === "PUSH" ? opCode.code - 0x5f : 0;

      byteCodeOutput += chalk.bgBlue(code[printCounter].toString(16));

      while (numToPush !== 0) {
        numToPush--;
        printCounter++;
        byteCodeOutput += chalk.bgCyan(code[printCounter].toString(16));
      }
    } else {
      byteCodeOutput += code[printCounter].toString(16);
    }
    printCounter++;
  }
  return `${chalk.bold("BYTECODE")}\n${byteCodeOutput}`;
}

async function generateRunStateOutput(
  runState: RunState,
  height: Number
): Promise<string> {
  const runStateTable = new Table({
    colWidths: [20, 20, 20, 20],
    head: ["STACK", "MEMORY", "STORAGE KEY", "STORAGE VALUE"],
  });

  for (let i = 0; i < height; i++) {
    runStateTable.push([
      ...generateStackline(i, runState),
      ...generateMemoryLine(i, runState),
      ...(await generateStorageLine(i, runState)),
    ]);
  }
  return runStateTable.toString();
}

async function executeStep(
  runState: RunState,
  opCodeList: OpcodeList,
  common: Common
) {
  const opCode = runState.code[runState.programCounter];
  runState.opCode = opCode;

  const opCodeInfo = opCodeList.get(opCode);
  if (!opCodeInfo) {
    throw new Error(`Invalid opcode ${toPrettyHex(opCode)}`);
  }

  // This is based on the EVM interpreter logic here:
  // https://github.com/ethereumjs/ethereumjs-monorepo/blob/master/packages/vm/src/evm/interpreter.ts#L147:L148
  // We increment the PC by 1 and the opHandlers will handle the push offset if necessary
  runState.programCounter++;

  runState.eei.useGas(new BN(opCodeInfo.fee), `${opCodeInfo.name} (base fee)`);

  try {
    // Execute opcode handler
    const opHandler = handlers.get(runState.opCode)!;
    if (opCodeInfo.isAsync) {
      await (opHandler as AsyncOpHandler).apply(null, [runState, common]);
    } else {
      opHandler.apply(null, [runState, common]);
    }
  } catch (error) {
    // If we reach the STOP instruction the evm throws an STOP error
    // This just means the execution is done
    if (error.error === "stop") {
      console.log("Execution Complete");
      process.exit(0);
    } else {
      console.error(error);
      process.exit(1);
    }
  }
}

function toPrettyHex(thing: number): string {
  return `0x${thing.toString(16)}`;
}

// Stolen from "@ethereumjs/vm/dist/evm/interpreter";
function getValidJumpDests(
  code: Buffer,
  opCodes: OpcodeList
): {
  validJumps: number[];
  validJumpSubs: number[];
} {
  const validJumps = [];
  const validJumpSubs = [];

  for (let i = 0; i < code.length; i++) {
    const curOpCode = opCodes.get(code[i])?.name;

    if (curOpCode === "JUMPDEST") {
      validJumps.push(i);
    }

    if (curOpCode === "BEGINSUB") {
      validJumpSubs.push(i);
    }
  }

  return { validJumps: validJumps, validJumpSubs: validJumpSubs };
}

function getOpcodeInfo(code: number, opCodeList: OpcodeList): Opcode {
  const opcodeInfo = opCodeList.get(code);
  if (!opcodeInfo) {
    throw new Error(`Invalid opcode ${toPrettyHex(code)}`);
  }
  return opcodeInfo;
}

function incrementCounter(
  currentCounter: number,
  code: Buffer,
  opCodeList: OpcodeList
) {
  const currentOpCode = code[currentCounter];
  const opcodeInfo = getOpcodeInfo(currentOpCode, opCodeList);
  let increment = 1;

  // If it is a PUSH instruction we want to skip over the data bytes
  if (opcodeInfo.name === "PUSH") {
    const numToPush = currentOpCode - 0x5f;

    increment = increment + numToPush;
  }
  return currentCounter + increment;
}
