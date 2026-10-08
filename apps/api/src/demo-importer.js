import { randomUUID } from 'node:crypto';
import { decimal, decimalString } from './lib/decimal.js';

export async function importDemoWholesaleCustomers(store, companyId, catalog) {
  const company = store.companies.get(companyId);
  if (!company || company.currency !== 'USD') {
    throw new Error('شركة USD فقط لاستيراد العملاء التجاريين');
  }

  let customersCreated = 0;
  let cashCustomers = 0;
  let creditCustomers = 0;
  let journalsCreated = 0;

  const mainWarehouse = [...store.warehouses.values()].find(w => w.companyId === companyId && !w.code.includes('BRANCH'));

  for (const customer of catalog.customers) {
    const existing = [...store.customers.values()].find(c => c.companyId === companyId && c.code === customer.code);
    if (existing) continue;

    const newCustomer = {
      id: randomUUID(),
      companyId,
      code: customer.code,
      name: customer.name,
      channel: 'wholesale',
      demo: true,
      openingBalances: [{ currency: 'USD', amount: decimalString(decimal(customer.balance)) }],
      phone: null,
      province: '',
      district: '',
      address: '',
      creditLimit: '0.000000',
      paymentPreference: 'credit',
      salesChannel: 'wholesale',
      active: true
    };

    store.customers.set(newCustomer.id, newCustomer);
    customersCreated++;

    if (customer.balance === 0) {
      cashCustomers++;
    } else {
      creditCustomers++;
      
      // Create opening balance journal entry for non-zero balances
      if (mainWarehouse && decimal(customer.balance) !== 0n) {
        const journalId = randomUUID();
        const operationId = randomUUID();
        const now = new Date().toISOString();
        
        const lines = [];
        const amount = decimal(customer.balance);
        
        if (amount > 0n) {
          // Customer owes us: Debit A/R, Credit Capital
          lines.push({
            account: 'receivables',
            debit: decimalString(amount),
            credit: '0.000000'
          });
          lines.push({
            account: 'capital',
            debit: '0.000000',
            credit: decimalString(amount)
          });
        } else {
          // We owe customer: Credit A/R, Debit Capital
          lines.push({
            account: 'receivables',
            debit: '0.000000',
            credit: decimalString(-amount)
          });
          lines.push({
            account: 'capital',
            debit: decimalString(-amount),
            credit: '0.000000'
          });
        }

        const journal = {
          id: journalId,
          companyId,
          currency: 'USD',
          occurredAt: now,
          entryNumber: `DEMO-OPENING-${customersCreated}`,
          status: 'posted',
          lines
        };

        store.journalEntries.set(journalId, journal);
        journalsCreated++;
      }
    }
  }

  return {
    customersCreated,
    cashCustomers,
    creditCustomers,
    journalsCreated,
    importedAt: new Date().toISOString()
  };
}

export async function importFurnitureCatalog(store, companyId, catalog) {
  let itemsCreated = 0;
  let warehousesCreated = 0;
  let pricesCreated = 0;
  let categoriesCreated = 0;

  // Create warehouses
  for (const warehouse of catalog.warehouses) {
    const existing = [...store.warehouses.values()].find(w => w.companyId === companyId && w.code === warehouse.code);
    if (existing) continue;

    store.warehouses.set(warehouse.id || randomUUID(), {
      id: warehouse.id || randomUUID(),
      companyId,
      code: warehouse.code,
      name: warehouse.name,
      kind: 'standard',
      active: true
    });
    warehousesCreated++;
  }

  // Create items and prices
  const defaultUnit = [...store.units.values()].find(u => u.companyId === companyId && u.code === 'PC');
  
  for (const item of catalog.items) {
    const existing = [...store.items.values()].find(i => i.companyId === companyId && i.sku === item.sku);
    if (existing) continue;

    const newItem = {
      id: randomUUID(),
      companyId,
      sku: item.sku,
      name: item.name,
      category: item.metadata?.category || '',
      description: item.metadata?.description || '',
      baseUnitId: defaultUnit?.id || randomUUID(),
      active: true
    };

    store.items.set(newItem.id, newItem);
    itemsCreated++;

    // Create price
    if (item.retailPrice) {
      store.prices.set(randomUUID(), {
        id: randomUUID(),
        companyId,
        itemId: newItem.id,
        unitId: defaultUnit?.id || randomUUID(),
        priceType: 'sale',
        currency: 'IQD',
        amount: decimalString(decimal(item.retailPrice)),
        active: true,
        validFrom: new Date().toISOString()
      });
      pricesCreated++;
    }

    // Handle categories
    if (item.metadata?.category) {
      const catExists = store.itemCategories?.get(companyId)?.has(item.metadata.category);
      if (!catExists) {
        if (!store.itemCategories) store.itemCategories = new Map();
        if (!store.itemCategories.get(companyId)) store.itemCategories.set(companyId, new Set());
        store.itemCategories.get(companyId).add(item.metadata.category);
        categoriesCreated++;
      }
    }
  }

  return {
    itemsCreated,
    warehousesCreated,
    pricesCreated,
    categoriesCreated,
    importedAt: new Date().toISOString()
  };
}
