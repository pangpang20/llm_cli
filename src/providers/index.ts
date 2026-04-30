import { BaseProvider } from "./base";
import { QwenProvider } from "./qwen";
import { DoubaoProvider } from "./doubao";
import { DeepSeekProvider } from "./deepseek";
import { KimiProvider } from "./kimi";

const providerMap: Record<string, () => BaseProvider> = {
  qwen: () => new QwenProvider(),
  doubao: () => new DoubaoProvider(),
  deepseek: () => new DeepSeekProvider(),
  kimi: () => new KimiProvider(),
};

export function getProvider(id: string): BaseProvider {
  const factory = providerMap[id];
  if (!factory) {
    const available = Object.keys(providerMap).join(", ");
    throw new Error(`Unknown provider "${id}". Available: ${available}`);
  }
  return factory();
}

export function listProviders(): { id: string; name: string }[] {
  return Object.entries(providerMap).map(([id, factory]) => {
    const p = factory();
    return { id, name: p.info.name };
  });
}

export { BaseProvider } from "./base";
