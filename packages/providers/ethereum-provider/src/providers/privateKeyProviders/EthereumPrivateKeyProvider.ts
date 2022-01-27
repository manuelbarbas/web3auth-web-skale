import { providerFromEngine } from "@toruslabs/base-controllers";
import { JRPCEngine, JRPCMiddleware } from "@toruslabs/openlogin-jrpc";
import { CHAIN_NAMESPACES, CustomChainConfig, RequestArguments, SafeEventEmitterProvider } from "@web3auth/base";
import { BaseProvider, BaseProviderConfig, BaseProviderState, createRandomId } from "@web3auth/base-provider";
import { ethErrors } from "eth-rpc-errors";

import {
  AddEthereumChainParameter,
  createAccountMiddleware,
  createChainSwitchMiddleware,
  createEthMiddleware,
  IAccountHandlers,
  IChainSwitchHandlers,
} from "../../rpc/ethRpcMiddlewares";
import { createJsonRpcClient } from "../../rpc/jrpcClient";
import { getProviderHandlers } from "./ethPrivatekeyUtils";

export interface EthereumPrivKeyProviderConfig extends BaseProviderConfig {
  chainConfig: Omit<CustomChainConfig, "chainNamespace">;
}

export interface EthereumPrivKeyProviderState extends BaseProviderState {
  privateKey?: string;
}
export class EthereumPrivateKeyProvider extends BaseProvider<BaseProviderConfig, EthereumPrivKeyProviderState, string> {
  constructor({ config, state }: { config: EthereumPrivKeyProviderConfig; state?: EthereumPrivKeyProviderState }) {
    super({ config: { chainConfig: { ...config.chainConfig, chainNamespace: CHAIN_NAMESPACES.EIP155 } }, state });
  }

  public static getProviderInstance = async (params: {
    privKey: string;
    chainConfig: Omit<CustomChainConfig, "chainNamespace">;
  }): Promise<EthereumPrivateKeyProvider> => {
    const providerFactory = new EthereumPrivateKeyProvider({ config: { chainConfig: params.chainConfig } });
    await providerFactory.setupProvider(params.privKey);
    return providerFactory;
  };

  public async enable(): Promise<string[]> {
    if (!this.state.privateKey)
      throw ethErrors.provider.custom({ message: "Private key is not found in state, plz pass it in constructor state param", code: 4902 });
    await this.setupProvider(this.state.privateKey);
    return this._providerEngineProxy.request({ method: "eth_accounts" });
  }

  public async setupProvider(privKey: string): Promise<void> {
    const providerHandlers = getProviderHandlers({
      privKey,
      chainConfig: this.config.chainConfig,
      getProviderEngineProxy: this.getProviderEngineProxy,
    });
    const ethMiddleware = createEthMiddleware(providerHandlers);
    const chainSwitchMiddleware = this.getChainSwitchMiddleware();
    const engine = new JRPCEngine();
    // Not a partial anymore because of checks in ctor
    const { networkMiddleware } = createJsonRpcClient(this.config.chainConfig as CustomChainConfig);
    engine.push(ethMiddleware);
    engine.push(chainSwitchMiddleware);
    engine.push(this.getAccountMiddleware());
    engine.push(networkMiddleware);
    const provider = providerFromEngine(engine);
    const providerWithRequest = {
      ...provider,
      request: async (args: RequestArguments) => {
        return provider.sendAsync({ jsonrpc: "2.0", id: createRandomId(), ...args });
      },
    } as SafeEventEmitterProvider;
    this.updateProviderEngineProxy(providerWithRequest);
    await this.lookupNetwork();
  }

  public async updateAccount(params: { privateKey: string }): Promise<void> {
    if (!this._providerEngineProxy) throw ethErrors.provider.custom({ message: "Provider is not initialized", code: 4902 });
    const existingKey = await this._providerEngineProxy.request<string>({ method: "eth_private_key" });
    if (existingKey !== params.privateKey) {
      await this.setupProvider(params.privateKey);
      this._providerEngineProxy.emit("accountsChanged", {
        accounts: await this._providerEngineProxy.request<string[]>({ method: "eth_accounts" }),
      });
    }
  }

  public async switchChain(params: { chainId: string }): Promise<void> {
    if (!this._providerEngineProxy) throw ethErrors.provider.custom({ message: "Provider is not initialized", code: 4902 });
    const chainConfig = this.getChainConfig(params.chainId);
    this.update({
      chainId: "loading",
    });
    this.configure({ chainConfig });
    const privKey = await this._providerEngineProxy.request<string>({ method: "eth_private_key" });
    await this.setupProvider(privKey);
  }

  protected async lookupNetwork(): Promise<string> {
    if (!this.provider) throw ethErrors.provider.custom({ message: "Provider is not initialized", code: 4902 });
    const { chainId } = this.config.chainConfig;
    if (!chainId) throw ethErrors.rpc.invalidParams("chainId is required while lookupNetwork");
    const network = await this._providerEngineProxy.request<string>({
      method: "net_version",
      params: [],
    });

    if (parseInt(chainId, 16) !== parseInt(network, 10)) throw ethErrors.provider.chainDisconnected(`Invalid network, net_version is: ${network}`);

    if (this.state.chainId !== chainId) {
      this.provider.emit("chainChanged", chainId);
      this.provider.emit("connect", { chainId });
    }
    this.update({ chainId });
    return network;
  }

  private getChainSwitchMiddleware(): JRPCMiddleware<unknown, unknown> {
    const chainSwitchHandlers: IChainSwitchHandlers = {
      addChain: async (params: AddEthereumChainParameter): Promise<void> => {
        const { chainId, chainName, rpcUrls, blockExplorerUrls, nativeCurrency } = params;
        this.addChain({
          chainNamespace: "eip155",
          chainId,
          ticker: nativeCurrency?.symbol || "ETH",
          tickerName: nativeCurrency?.name || "Ether",
          displayName: chainName,
          rpcTarget: rpcUrls[0],
          blockExplorer: blockExplorerUrls?.[0] || "",
        });
      },
      switchChain: async (params: { chainId: string }): Promise<void> => {
        const { chainId } = params;
        await this.switchChain({ chainId });
      },
    };
    const chainSwitchMiddleware = createChainSwitchMiddleware(chainSwitchHandlers);
    return chainSwitchMiddleware;
  }

  private getAccountMiddleware(): JRPCMiddleware<unknown, unknown> {
    const accountHandlers: IAccountHandlers = {
      updatePrivatekey: async (params: { privateKey: string }): Promise<void> => {
        const { privateKey } = params;
        await this.updateAccount({ privateKey });
      },
    };
    return createAccountMiddleware(accountHandlers);
  }
}
