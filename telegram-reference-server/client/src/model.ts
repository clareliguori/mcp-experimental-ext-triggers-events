import { BedrockModel, type Model } from "@strands-agents/sdk";
import { AnthropicModel } from "@strands-agents/sdk/models/anthropic";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";

export function createModel(): Model {
  const provider = process.env.MODEL_PROVIDER ?? "bedrock";
  switch (provider) {
    case "anthropic": {
      const model = new AnthropicModel({
        modelId: process.env.MODEL_ID ?? "claude-sonnet-4-6",
      });
      console.log(`Using Anthropic (${model.getConfig().modelId})`);
      return model;
    }
    case "openai": {
      const model = new OpenAIModel({
        api: "chat",
        modelId: process.env.MODEL_ID ?? "gpt-5.4",
      });
      console.log(`Using OpenAI (${model.getConfig().modelId})`);
      return model;
    }
    default: {
      const model = new BedrockModel({
        modelId: process.env.MODEL_ID ?? "global.anthropic.claude-sonnet-4-6",
      });
      console.log(`Using Bedrock (${model.getConfig().modelId})`);
      return model;
    }
  }
}
