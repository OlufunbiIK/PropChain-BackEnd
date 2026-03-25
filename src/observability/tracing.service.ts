import { Injectable } from '@nestjs/common';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

@Injectable()
export class TracingService {
  private sdk: NodeSDK;

  init() {
    // Initialize OpenTelemetry with service name and auto-instrumentation
    // Note: Resource configuration can be extended if needed
    try {
      this.sdk = new NodeSDK({
        serviceName: 'propchain-backend',
        instrumentations: [getNodeAutoInstrumentations()],
      });

      this.sdk.start();
    } catch (error) {
      console.warn('Failed to initialize OpenTelemetry:', error);
    }
  }
}