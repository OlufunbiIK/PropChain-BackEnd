// blockchain.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { ProviderFactory } from './providers/provider.factory';
import { SupportedChain } from './enums/supported-chain.enum';

@Injectable()
export class BlockchainService {
  private readonly logger = new Logger(BlockchainService.name);
  private providers = new Map<SupportedChain, ethers.JsonRpcProvider>();

  constructor() {
    Object.values(SupportedChain).forEach(chain => {
      this.providers.set(chain, ProviderFactory.create(chain));
    });
  }

  getProvider(chain: SupportedChain) {
    return this.providers.get(chain);
  }

  async estimateGas(): Promise<number> {
    // In a real application, this would use a provider to estimate fees.
    // For now, return a placeholder value.
    this.logger.log('Estimating gas fees...');
    return 0.0005; // Placeholder value
  }

  async createEscrowWallet(): Promise<string> {
    this.logger.log('Creating new escrow wallet...');
    const wallet = ethers.Wallet.createRandom();
    return wallet.address;
  }

  async getTransactionReceipt(hash: string): Promise<any> {
    this.logger.log(`Fetching receipt for hash: ${hash}`);
    const provider = this.getProvider(SupportedChain.ETHEREUM);
    if (!provider) {
      throw new Error('Default provider not found');
    }
    return provider.getTransactionReceipt(hash);
  }

  async getNetworkStatus(chain: SupportedChain) {
    const provider = this.getProvider(chain);
    if (!provider) {
      throw new Error(`Provider not found for chain: ${chain}`);
    }
    const block = await provider.getBlockNumber();

    return {
      chain,
      latestBlock: block,
      healthy: true,
    };
  }

  /**
   * Estimate gas for a transaction
   */
  estimateGas(): number {
    // Return estimated gas fee in ETH
    return 0.001; // Example value
  }

  /**
   * Create an escrow wallet address
   */
  async createEscrowWallet(): Promise<string> {
    // Generate a random escrow wallet address
    const wallet = ethers.Wallet.createRandom();
    return wallet.address;
  }

  /**
   * Get transaction receipt from blockchain
   */
  async getTransactionReceipt(txHash: string): Promise<{ confirmations: number }> {
    // Return mock confirmations
    return { confirmations: 6 };
  }
}
