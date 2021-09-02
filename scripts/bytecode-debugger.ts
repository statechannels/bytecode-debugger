#!/usr/bin/env -S npx ts-node

import { OpcodeList } from "@ethereumjs/vm/dist/evm/opcodes";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import Table from "cli-table3";
import chalk, { Chalk } from "chalk";
import _ from "lodash";
import { ExecutionManager, ExecutionInfo } from "../src/execution-manager";
import {
  toPrettyHex,
  toPrettyByte,
  incrementCounter,
  formatBuffer,
  addHexPrefix,
} from "../src/utils";
import ui from "yargs/";
import fs from "fs";
import { utils, BigNumber } from "ethers";
import jsonfile from "jsonfile";
import prompts from "prompts";
debugBytecode();

async function debugBytecode() {
  const commandArguments = await yargs(hideBin(process.argv))
    .option("b", {
      description: `A path to a file containing the bytecode to debug.
    This is should be the ${chalk.bold("runtime")} bytecode.
    This can be created by passing the '--bin-runtime' flag into solc.`,
      alias: "bytecodeFile",
      demandOption: true,
      type: "string",
    })
    .option("a", {
      alias: "abi",
      description: `A path to the abi file generated by solc.
    This can be created by passing the '--bin-runtime' flag into solc.`,
      demandOption: true,
      type: "string",
      default: "0",
    }).argv;

  const abiFile = await jsonfile.readFile(commandArguments.a);
  const abi = new utils.Interface(abiFile);
  const choices = Object.keys(abi.functions).map((k) => ({
    value: k,
    title: k,
  }));

  const { functionToCall } = await prompts({
    type: "select",
    name: "functionToCall",
    choices,
    message: "Which function do you want to call?'",
  });

  let inputValues = [];
  for (const input of abi.functions[functionToCall].inputs) {
    inputValues.push(await getInputValue(input, input.name));
  }
  const callData = abi.encodeFunctionData(
    abi.functions[functionToCall],
    inputValues
  );

  const { callValue } = await prompts({
    type: "number",
    name: "callValue",
    message: `Enter the amount of wei to be sent to the function.`,
  });

  const code = Buffer.from(
    await fs.promises.readFile(commandArguments.b, "utf8"),
    "hex"
  );
  await runCode(
    code,
    Buffer.from(callData.slice(2), "hex"),
    BigNumber.from(callValue),
    abi.functions[functionToCall]
  );
}

async function getInputValue(
  input: utils.ParamType,
  argumentName: string
): Promise<any> {
  if (input.baseType === "tuple") {
    const tuple = [];
    for (const component of input.components) {
      tuple.push(await getInputValue(component, component.name));
    }
    return tuple;
  }
  if (input.baseType === "array") {
    let { keepGoing } = await prompts({
      type: "confirm",
      name: "keepGoing",
      message: `Add an item to the argument array for ${argumentName}`,
    });
    const arrayValues = [];
    while (keepGoing) {
      arrayValues.push(await getInputValue(input.arrayChildren, "array"));
      keepGoing = (
        await prompts({
          type: "confirm",
          name: "keepGoing",
          message: `Add an item to the argument array for ${argumentName}`,
        })
      ).keepGoing;
    }
    return arrayValues;
  }

  if (input.baseType === "address") {
    const { inputValue } = await prompts({
      type: "text",
      name: "inputValue",
      validate: (value) =>
        utils.isAddress(addHexPrefix(value))
          ? true
          : "Please enter a valid address",
      message: `Enter an address for argument ${argumentName}`,
    });
    return utils.getAddress(addHexPrefix(inputValue));
  }
  if (input.baseType === "bool") {
    return (
      await prompts({
        type: "select",
        name: "inputValue",
        choices: [
          { title: "True", value: true },
          { title: "False", value: false },
        ],
        message: `Enter a boolean for argument ${argumentName}`,
      })
    ).inputValue;
  }
  if (input.baseType === "string") {
    return (
      await prompts({
        type: "text",
        name: "inputValue",

        message: `Enter a string for argument ${argumentName}`,
      })
    ).inputValue;
  }
  if (input.baseType.includes("bytes")) {
    const { inputValue } = await prompts({
      type: "text",
      name: "inputValue",
      validate: (value) =>
        utils.isHexString(addHexPrefix(value))
          ? true
          : "Please enter a valid hex string",
      message: `Enter a hex string for argument ${argumentName}`,
    });

    return BigNumber.from(addHexPrefix(inputValue));
  }

  if (input.baseType.includes("int")) {
    return (
      await prompts({
        type: "number",
        name: "inputValue",
        min: input.baseType.includes("uint") ? 0 : -Infinity,
        message: `Enter a number for argument ${argumentName}`,
      })
    ).inputValue;
  }
}
async function runCode(
  code: Buffer,
  callData: Buffer,
  callValue: BigNumber,
  functionToCall: utils.FunctionFragment
) {
  const executionManager = await ExecutionManager.create(
    code,
    callData,
    callValue
  );

  let execInfo = executionManager.currentStep;

  while (true) {
    await outputExecInfo(
      execInfo,
      code,
      callData,
      callValue,
      executionManager.opCodeList,
      functionToCall,
      10
    );

    const choices = [];
    if (executionManager.canStepForward) {
      choices.push({ title: "Step Forwards", value: "stepForward" });
    }
    if (executionManager.canStepBackward) {
      choices.push({ title: "Step Backwards", value: "stepBackward" });
    }
    choices.push({ title: "Quit", value: "quit" });

    const response = await prompts({
      type: "select",
      name: "action",
      choices,
      message: "What do you want to do?",
    });
    switch (response.action) {
      case "stepForward":
        execInfo = await executionManager.stepForwards();
        break;
      case "stepBackward":
        execInfo = await executionManager.stepBackwards();
        break;
      case "quit":
        process.exit(0);
    }
  }
}

async function outputExecInfo(
  execInfo: ExecutionInfo,
  code: Buffer,
  callData: Buffer,
  callValue: BigNumber,
  opCodeList: OpcodeList,
  functionToCall: utils.FunctionFragment,
  height: number
) {
  const storageTable = await generateStorageTable(execInfo, height);
  const stackTable = await generateStackTable(execInfo, height);
  const memoryTable = generateMemoryTable(execInfo, height);
  const instructionTable = await generateInstructionTable(
    execInfo.initialPC,
    code,
    height,
    opCodeList
  );
  const masterTable = new Table({
    head: ["", "STACK", "MEMORY", "STORAGE"],
    style: {
      "padding-left": 0,
      "padding-right": 0,
    },
  });
  masterTable.push([instructionTable, stackTable, memoryTable, storageTable]);

  const bytecodeOutput = generateBytecodeOutput(
    code,
    execInfo.initialPC,
    opCodeList
  );

  console.clear();
  console.log(chalk.bold("FUNCTION"));
  // NOTE: format('sighhash') actually returns the function
  console.log(
    `${functionToCall.format("sighash")}: 0x${chalk.inverse(
      utils.Interface.getSighash(functionToCall).slice(2)
    )}`
  );
  console.log(chalk.bold("CALL DATA"));
  let callDataOutput = "0x";
  for (let i = 0; i < callData.length; i++) {
    if (i < 4) {
      callDataOutput =
        callDataOutput + chalk.inverse(toPrettyByte(callData[i]));
    } else {
      callDataOutput = callDataOutput + toPrettyByte(callData[i]);
    }
  }
  console.log(callDataOutput);
  console.log(chalk.bold("CALL VALUE"));
  console.log(callValue.toHexString());

  console.log(bytecodeOutput);
  console.log(`${chalk.bold("Total Gas Used:")} ${execInfo.gasUsed}`);
  console.log(masterTable.toString());
  const opCodeInfo = opCodeList.get(code[execInfo.initialPC]);
  if (opCodeInfo && opCodeInfo.name === "STOP") {
    console.log(chalk.bgGreen("STOP command reached. Execution Complete"));
  }
  if (opCodeInfo && opCodeInfo.name === "REVERT") {
    console.log(chalk.bgRed("REVERT command reached. Execution Complete"));
  }
}
function generateMemoryTable(execInfo: ExecutionInfo, height: number) {
  const memoryTable = new Table({
    head: ["ADDRESS", "VALUE"],
    colWidths: [10, 36],
  });

  let currentIndex = 0;
  let lineHeight = 0;
  while (lineHeight < height) {
    const memoryLine = execInfo.memory.read(currentIndex, 16);
    memoryTable.push([toPrettyHex(currentIndex), formatBuffer(memoryLine)]);
    currentIndex += 16;
    lineHeight++;
  }
  return memoryTable.toString();
}

async function generateInstructionTable(
  currentCounter: number,
  code: Buffer,
  height: number,
  opCodeList: OpcodeList
): Promise<string> {
  const opCodeExecTable = new Table({
    head: ["PC", "CODE", "INSTRUCTION", "GAS"],
    colWidths: [8, 8, 20, 8],
  });

  const numberOfLines = Math.min(height, code.length - currentCounter);

  let printCounter = currentCounter;

  for (let i = 0; i < numberOfLines && printCounter < code.length; i++) {
    const opCodeInfo = opCodeList.get(code[printCounter]);
    const currentColor =
      printCounter === currentCounter ? chalk.whiteBright.bgBlue : chalk.reset;
    const valueColor =
      printCounter === currentCounter
        ? chalk.whiteBright.bgMagenta
        : chalk.reset;

    opCodeExecTable.push([
      currentColor(toPrettyHex(printCounter)),
      toPrettyHex(code[printCounter]),
      getInstructionName(
        opCodeList,
        printCounter,
        currentColor,
        valueColor,
        code
      ),
      opCodeInfo ? currentColor(toPrettyHex(opCodeInfo.fee)) : "",
    ]);

    printCounter = incrementCounter(printCounter, code, opCodeList);
  }
  return opCodeExecTable.toString();
}

function getInstructionName(
  opCodeList: OpcodeList,
  currentCounter: number,
  instructionColor: Chalk,
  valueColor: Chalk,
  code: Buffer
): string {
  const opCodeInfo = opCodeList.get(code[currentCounter]);
  // It looks like bin-runtime output can contain invalid opcodes as long as they're not executed
  if (!opCodeInfo) {
    return toPrettyHex(code[currentCounter]);
  }

  let instruction = `${instructionColor(opCodeInfo.fullName)}`;
  if (opCodeInfo.name === "PUSH") {
    const values = code.slice(
      currentCounter + 1,
      incrementCounter(currentCounter, code, opCodeList)
    );
    instruction += ` ${valueColor(values.toString("hex"))}`;
  }
  return instruction;
}
function generateBytecodeOutput(
  code: Buffer,
  currentCounter: number,
  opCodeList: OpcodeList
): string {
  let byteCodeOutput = "";
  const lineWidth = 100;
  const startIndex = Math.max(0, currentCounter - lineWidth * 1);
  const finishIndex = startIndex + lineWidth * 10;
  let printCounter = startIndex;

  while (printCounter < finishIndex && printCounter < code.length) {
    if (currentCounter === printCounter) {
      const opCode = opCodeList.get(code[printCounter])!;
      let numToPush = opCode.name === "PUSH" ? opCode.code - 0x5f : 0;

      byteCodeOutput += chalk.whiteBright.bgBlue(
        toPrettyByte(code[printCounter])
      );

      while (numToPush !== 0) {
        numToPush--;
        printCounter++;

        byteCodeOutput += chalk.whiteBright.bgMagenta(
          toPrettyByte(code[printCounter])
        );
      }
    } else {
      byteCodeOutput += toPrettyByte(code[printCounter]);
    }

    printCounter++;
  }
  if (finishIndex < code.length) {
    byteCodeOutput = byteCodeOutput + "...";
  }
  return `${chalk.bold("BYTECODE")}\n${byteCodeOutput}`;
}

async function generateStackTable(
  info: ExecutionInfo,
  height: Number
): Promise<string> {
  const stackTable = new Table({
    colWidths: [8, 20],
    head: ["POS", "VALUE"],
  });
  const stackItems = _.clone(info.stack._store)
    .map((bn) => `0x${bn.toString("hex")}`)
    .reverse();
  for (let i = 0; i < height; i++) {
    if (i < stackItems.length) {
      stackTable.push([i.toString(), stackItems[i]]);
    } else {
      stackTable.push(["", ""]);
    }
  }
  return stackTable.toString();
}

async function generateStorageTable(
  info: ExecutionInfo,
  height: Number
): Promise<string> {
  const storageTable = new Table({
    colWidths: [10, 20],
    head: ["KEY", "VALUE"],
  });
  const { storageDump } = info;
  const storageItems = Object.keys(storageDump)
    .filter((key) => !storageDump[key].includes("deadbeaf"))
    .map((key) => [key, storageDump[key]]);
  for (let i = 0; i < height; i++) {
    if (i < storageItems.length) {
      storageTable.push(storageItems[i]);
    } else {
      storageTable.push(["", ""]);
    }
  }
  return storageTable.toString();
}
