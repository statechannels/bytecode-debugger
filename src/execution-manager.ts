import Common from "@ethereumjs/common";
import { RunState } from "@ethereumjs/vm/dist/evm/interpreter";
import Memory from "@ethereumjs/vm/dist/evm/memory";
import {
  OpcodeList,
  handlers,
  AsyncOpHandler,
  Opcode,
  getOpcodesForHF,
} from "@ethereumjs/vm/dist/evm/opcodes";
import Stack from "@ethereumjs/vm/dist/evm/stack";
import { DefaultStateManager } from "@ethereumjs/vm/dist/state";
import {
  EIP2929StateManager,
  StorageDump,
} from "@ethereumjs/vm/dist/state/interface";
import { Account, Address, BN } from "ethereumjs-util";
import { BigNumber, utils } from "ethers";
import _ from "lodash";
import { evmSetup } from "./utils";

export type ExecutionInfo = {
  initialPC: number;
  gasUsed: number;
  memory: Memory;
  storageDump: StorageDump;
  stack: Stack;
};

export class ExecutionManager {
  private latestExecuted = 0;
  private currentIndex = 0;
  private history: ExecutionInfo[] = [];
  private runState: RunState;
  private common: Common;
  private initialGas: number;
  private safeToDumpStorage = false;

  public opCodeList: OpcodeList;

  public static async create(
    code: Buffer,
    callData: Buffer,
    callValue: BigNumber
  ): Promise<ExecutionManager> {
    const { runState, common } = evmSetup(callData, callValue, code);

    return new ExecutionManager(runState, common);
  }
  private constructor(runState: RunState, common: Common) {
    this.runState = runState;
    this.initialGas = this.runState.eei.getGasLeft().toNumber();
    this.opCodeList = getOpcodesForHF(common);
    this.common = common;

    // This is the initial state for the PC: 0
    this.history.push({
      stack: new Stack(),
      initialPC: 0,
      memory: new Memory(),
      storageDump: {},
      gasUsed: 0,
    });
  }

  get currentStep(): ExecutionInfo {
    return this.history[this.currentIndex];
  }

  get canStepBackward(): boolean {
    return this.currentIndex > 0;
  }

  get canStepForward(): boolean {
    const opCode = this.runState.code[this.currentStep.initialPC];
    const opCodeInfo = this.opCodeList.get(opCode);
    if (
      opCodeInfo &&
      (opCodeInfo.name === "STOP" || opCodeInfo.name === "REVERT")
    ) {
      return false;
    }

    return this.currentIndex < this.runState.code.length;
  }

  private async executeStep(): Promise<ExecutionInfo> {
    const opCode = this.runState.code[this.runState.programCounter];
    this.runState.opCode = opCode;

    const opCodeInfo = this.opCodeList.get(opCode);
    if (!opCodeInfo) {
      throw new Error(`Invalid opcode ${Opcode}`);
    }

    this.runState.eei.useGas(
      new BN(opCodeInfo.fee),
      `${opCodeInfo.name} (base fee)`
    );

    this.runState.programCounter++;
    const { memory, stack, stateManager } = this.runState;
    try {
      // Execute opcode handler
      const opHandler = handlers.get(this.runState.opCode)!;
      if (opCodeInfo.isAsync) {
        await (opHandler as AsyncOpHandler).apply(null, [
          this.runState,
          this.common,
        ]);
      } else {
        opHandler.apply(null, [this.runState, this.common]);
      }
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
    if (opCodeInfo.name === "SSTORE") {
      this.safeToDumpStorage = true;
    }
    const storageDump = this.safeToDumpStorage
      ? await stateManager.dumpStorage(Address.zero())
      : {};

    return {
      stack,
      memory,
      storageDump,
      initialPC: this.runState.programCounter,
      gasUsed: this.initialGas - this.runState.eei.getGasLeft().toNumber(),
    };
  }

  async stepBackwards(): Promise<ExecutionInfo> {
    if (this.currentIndex >= 0) {
      this.currentIndex--;
    }
    return this.history[this.currentIndex];
  }

  async stepForwards(): Promise<ExecutionInfo> {
    this.currentIndex++;
    if (this.currentIndex < this.history.length) {
      return this.history[this.currentIndex];
    } else {
      const execInfo = await this.executeStep();
      this.history.push(_.cloneDeep(execInfo));
      this.latestExecuted = Math.max(this.currentIndex, this.latestExecuted);
      return execInfo;
    }
  }
}
