import { getFromPrepared, preprocessPlayer } from "./solvers.ts";
import { isOneOf } from "../../utils.ts";

export default function main(input: Input): Output;
export default function main(preprocessedPlayer: string, solvers: { n: ((val: string) => string) | null; sig: ((val: string) => string) | null }, requests: Request[]): Output;
export default function main(
  inputOrPlayer: Input | string,
  solvers?: { n: ((val: string) => string) | null; sig: ((val: string) => string) | null },
  requests?: Request[]
): Output {
  // 重载1：使用 Input 对象（原有逻辑）
  if (typeof inputOrPlayer === "object" && inputOrPlayer.type) {
    const input = inputOrPlayer;
    const preprocessedPlayer =
      input.type === "player"
        ? preprocessPlayer(input.player)
        : input.preprocessed_player;
    const solversFromPrepared = getFromPrepared(preprocessedPlayer);

    const responses = input.requests.map((input): Response => {
      if (!isOneOf(input.type, "n", "sig")) {
        return {
          type: "error",
          error: `Unknown request type: ${input.type}`,
        };
      }
      const solver = solversFromPrepared[input.type];
      if (!solver) {
        return {
          type: "error",
          error: `Failed to extract ${input.type} function`,
        };
      }
      try {
        return {
          type: "result",
          data: Object.fromEntries(
            input.challenges.map((challenge) => [challenge, solver(challenge)]),
          ),
        };
      } catch (error) {
        return {
          type: "error",
          error:
            error instanceof Error
              ? `${error.message}\n${error.stack}`
              : `${error}`,
        };
      }
    });

    const output: Output = {
      type: "result",
      responses,
    };
    if (input.type === "player" && input.output_preprocessed) {
      output.preprocessed_player = preprocessedPlayer;
    }
    return output;
  }

  // 重载2：直接传入预处理的字符串和solvers（新增，用于性能优化）
  if (typeof inputOrPlayer === "string" && solvers && requests) {
    const responses = requests.map((input): Response => {
      if (!isOneOf(input.type, "n", "sig")) {
        return {
          type: "error",
          error: `Unknown request type: ${input.type}`,
        };
      }
      const solver = solvers[input.type];
      if (!solver) {
        return {
          type: "error",
          error: `Failed to extract ${input.type} function`,
        };
      }
      try {
        return {
          type: "result",
          data: Object.fromEntries(
            input.challenges.map((challenge) => [challenge, solver(challenge)]),
          ),
        };
      } catch (error) {
        return {
          type: "error",
          error:
            error instanceof Error
              ? `${error.message}\n${error.stack}`
              : `${error}`,
        };
      }
    });

    return {
      type: "result",
      responses,
    };
  }

  throw new Error("Invalid arguments passed to main function");
}

export type Input =
  | {
      type: "player";
      player: string;
      requests: Request[];
      output_preprocessed: boolean;
    }
  | {
      type: "preprocessed";
      preprocessed_player: string;
      requests: Request[];
    };

type Request = {
  type: "n" | "sig";
  challenges: string[];
};

type Response =
  | {
      type: "result";
      data: Record<string, string>;
    }
  | {
      type: "error";
      error: string;
    };

export type Output =
  | {
      type: "result";
      preprocessed_player?: string;
      responses: Response[];
    }
  | {
      type: "error";
      error: string;
    };
