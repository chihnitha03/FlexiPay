// Zero-code "Pricing Advisor" integration (PRD §5.5): the merchant only supplies a plan catalog
// and a checkout URL. No customer data, no metering, no plan mutations — FlexPrice relies on
// customer-entered estimates and hands checkout back to the merchant.

export class StaticCatalogAdapter {
  constructor({ manifest, plans }) {
    this.manifest = { ...manifest, capabilities: ['plans'] };
    this.plans = plans;
  }
  async getManifest() { return this.manifest; }
  async getPlans() { return this.plans; }
}
