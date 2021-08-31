import Memory from "@ethereumjs/vm/dist/evm/memory";
import { BN } from "ethereumjs-util";
import Stack from "@ethereumjs/vm/dist/evm/stack";
import { Opcode, OpcodeList } from "@ethereumjs/vm/dist/evm/opcodes";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import Table from "cli-table";
import chalk, { Chalk } from "chalk";
import _ from "lodash";
import { StorageDump } from "@ethereumjs/vm/dist/state/interface";
import { ExecutionManager, ExecutionInfo } from "./execution-manager";
import { toPrettyHex, toPrettyByte, incrementCounter } from "./utils";
import { prompt } from "enquirer";
import fs from "fs";

debugOpcode();

async function debugOpcode() {
  // TODO: Point these to files
  const commandArguments = await yargs(hideBin(process.argv))
    .option("b", {
      alias: "bytecodeFile",
      demandOption: true,
      type: "string",
    })
    .option("c", { alias: "calldata", type: "string", default: "0" })
    .option("v", { alias: "callvalue", type: "string", default: "0" }).argv;

  const code = Buffer.from(
    await fs.promises.readFile(commandArguments.b, "utf8"),
    "hex"
  );
  await runCode(
    code,
    Buffer.from(commandArguments.c, "hex"),
    new BN(commandArguments.v, "hex")
  );
}

async function runCode(code: Buffer, callData: Buffer, callValue: BN) {
  const executionManager = new ExecutionManager(code, callData, callValue);
  let execInfo = executionManager.currentStep;

  while (true) {
    await outputExecInfo(
      execInfo,
      code,
      callData,
      callValue,
      executionManager.opCodeList,
      10
    );

    const choices = [];
    if (execInfo.initialPC < code.length) {
      choices.push("Step Forwards");
    }
    if (execInfo.initialPC > 0) {
      choices.push("Step Backwards");
    }
    choices.push("Quit");

    const response = (await prompt({
      type: "autocomplete",
      name: "action",
      choices,
      message: "What do you want to do?",
    })) as { action: "Step Forwards" | "Step Backwards" | "Quit" };

    switch (response.action) {
      case "Step Forwards":
        execInfo = await executionManager.stepForwards();
        break;
      case "Step Backwards":
        execInfo = await executionManager.stepBackwards();
        break;
      case "Quit":
        process.exit(0);
    }
  }
}

async function outputExecInfo(
  execInfo: ExecutionInfo,
  code: Buffer,
  callData: Buffer,
  callValue: BN,
  opCodeList: OpcodeList,
  height: number
) {
  const runStateOutput = await generateRunStateOutput(execInfo, height);

  const instructionTable = await generateInstructionTable(
    execInfo.initialPC,
    code,
    height,
    opCodeList
  );
  const masterTable = new Table();
  masterTable.push([instructionTable.toString(), runStateOutput.toString()]);

  const bytecodeOutput = generateBytecodeOutput(
    code,
    execInfo.initialPC,
    opCodeList
  );

  console.clear();
  console.log(chalk.bold("CALL DATA"));
  console.log(`0x${callData.toString("hex")}`);
  console.log(chalk.bold("CALL VALUE"));
  console.log(`0x${callValue.toString("hex")}`);

  console.log(bytecodeOutput);
  console.log(`${chalk.bold("Total Gas Used:")} ${execInfo.gasUsed}`);
  console.log(masterTable.toString());
}

async function generateStorageLine(
  lineCounter: number,
  storageDump: StorageDump
): Promise<string[]> {
  const storageItems = Object.keys(storageDump)
    .filter((key) => !storageDump[key].includes("deadbeaf"))
    .map((key) => [key, storageDump[key]]);

  if (lineCounter < storageItems.length) {
    return storageItems[lineCounter];
  } else {
    return ["", ""];
  }
}

function generateStackline(lineCounter: number, stack: Stack) {
  const line: string[] = [];
  const stackItems = _.clone(stack._store)
    .map((bn) => `0x${bn.toString("hex")}`)
    .reverse();
  if (lineCounter < stackItems.length) {
    line.push(stackItems[lineCounter]);
  } else {
    line.push("");
  }
  return line;
}

function generateMemoryLine(lineCounter: number, memory: Memory) {
  const line: string[] = [];

  // TODO: Just calculate the iterator and copy the value
  const memoryItems = _.clone(memory._store).reverse();

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
    head: ["PC", "OP CODE", "INSTRUCTION", "GAS COST"],
    colWidths: [10, 10, 20, 10],
  });

  const numberOfLines = Math.min(height, code.length - currentCounter);

  let printCounter = currentCounter;

  for (let i = 0; i < numberOfLines; i++) {
    const currentColor =
      printCounter === currentCounter ? chalk.bgBlue : chalk.white;
    const valueColor =
      printCounter === currentCounter ? chalk.bgMagenta : chalk.white;
    const opcodeInfo = getOpcodeInfo(code[printCounter], opCodeList);
    opCodeExecTable.push([
      currentColor(toPrettyHex(printCounter)),
      toPrettyHex(opcodeInfo.code),
      getInstructionName(
        opCodeList,
        printCounter,
        currentColor,
        valueColor,
        code
      ),
      currentColor(toPrettyHex(opcodeInfo.fee)),
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
  const opCodeInfo = getOpcodeInfo(code[currentCounter], opCodeList);
  let instruction = `${instructionColor(opCodeInfo.fullName)}`;
  if (opCodeInfo.name === "PUSH") {
    const values = code.slice(
      currentCounter + 1,
      incrementCounter(currentCounter, code, opCodeList)
    );
    instruction += ` ${valueColor("0x" + values.toString("hex"))}`;
  }
  return instruction;
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

      byteCodeOutput += chalk.bgBlue(toPrettyByte(code[printCounter]));

      while (numToPush !== 0) {
        numToPush--;
        printCounter++;
        byteCodeOutput += chalk.bgMagenta(toPrettyByte(code[printCounter]));
      }
    } else {
      byteCodeOutput += toPrettyByte(code[printCounter]);
    }
    printCounter++;
  }
  return `${chalk.bold("BYTECODE")}\n${byteCodeOutput}`;
}

async function generateRunStateOutput(
  info: ExecutionInfo,
  height: Number
): Promise<string> {
  const runStateTable = new Table({
    colWidths: [20, 20, 20, 20],
    head: ["STACK", "MEMORY", "STORAGE KEY", "STORAGE VALUE"],
  });

  for (let i = 0; i < height; i++) {
    runStateTable.push([
      ...generateStackline(i, info.stack),
      ...generateMemoryLine(i, info.memory),
      ...(await generateStorageLine(i, info.storageDump)),
    ]);
  }
  return runStateTable.toString();
}

function getOpcodeInfo(code: number, opCodeList: OpcodeList): Opcode {
  const opcodeInfo = opCodeList.get(code);
  if (!opcodeInfo) {
    throw new Error(`Invalid opcode ${toPrettyHex(code)}`);
  }
  return opcodeInfo;
}

