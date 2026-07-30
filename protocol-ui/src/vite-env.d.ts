/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID: string;
  readonly VITE_RPC_URL: string;
  readonly VITE_BUNDLER_URL: string;
  readonly VITE_PAYMASTER_URL: string;
  readonly VITE_ENTRYPOINT: string;
  readonly VITE_FACTORY: string;
  readonly VITE_REGISTRY: string;
  readonly VITE_EXECUTOR: string;
  readonly VITE_PAYMASTER: string;
  readonly VITE_USDG: string;
  readonly VITE_BUYBACK: string;
  readonly VITE_TEST_MEME: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
