import { Block } from "@ethereumjs/block";
import Common, { Chain } from "@ethereumjs/common";
import EEI from "@ethereumjs/vm/dist/evm/eei";
import EVM from "@ethereumjs/vm/dist/evm/evm";
import { RunState } from "@ethereumjs/vm/dist/evm/interpreter";
import Memory from "@ethereumjs/vm/dist/evm/memory";
import {
  OpcodeList,
  Opcode,
  getOpcodesForHF,
} from "@ethereumjs/vm/dist/evm/opcodes";
import Stack from "@ethereumjs/vm/dist/evm/stack";
import { DefaultStateManager } from "@ethereumjs/vm/dist/state";
import { BN, Address } from "ethereumjs-util";
import level from "level";
import { SecureTrie as Trie } from "merkle-patricia-tree";
import { utils } from "ethers";

export function getValidJumpDests(
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

  return { validJumps, validJumpSubs };
}

export function toPrettyByte(thing: number): string {
  return utils.hexZeroPad(toPrettyHex(thing), 1).slice(2);
}

export function toPrettyHex(thing: number): string {
  return `0x${thing.toString(16)}`;
}

export function getOpcodeInfo(code: number, opCodeList: OpcodeList): Opcode {
  const opcodeInfo = opCodeList.get(code);
  if (!opcodeInfo) {
    throw new Error(`Invalid opcode ${toPrettyHex(code)}`);
  }
  return opcodeInfo;
}

export function evmSetup(
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
  // TODO: Just grabbed this from a quick google, this should probably be a param with a sane default
  const START_GAS = 15000000;
  const eei = new EEI(
    env,
    stateManager,
    { _vm: { DEBUG: true } } as EVM, // TODO: Hacky AF
    common,
    new BN(START_GAS)
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

export function incrementCounter(
  currentCounter: number,
  code: Buffer,
  opCodeList: OpcodeList
) {
  const currentOpCode = code[currentCounter];
  const opcodeInfo = opCodeList.get(currentOpCode);
  let increment = 1;

  // If it is a PUSH instruction we want to skip over the data bytes
  if (opcodeInfo?.name === "PUSH") {
    const numToPush = currentOpCode - 0x5f;

    increment = increment + numToPush;
  }
  return currentCounter + increment;
}
