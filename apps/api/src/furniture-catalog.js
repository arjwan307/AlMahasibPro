export function furnitureCatalog() {
  const warehouses = [
    { code: 'MAIN', name: 'المستودع الرئيسي' },
    { code: 'BRANCH1', name: 'الفرع الأول' },
    { code: 'BRANCH2', name: 'الفرع الثاني' },
    { code: 'BRANCH3', name: 'الفرع الثالث' },
    { code: 'BRANCH4', name: 'الفرع الرابع' }
  ];

  const categories = [
    'أرائك وكنب',
    'غرف نوم',
    'طاولات وكراسي',
    'خزائن وأدراج',
    'ديكور وإكسسوارات',
    'حياة عملية'
  ];

  const items = [];
  
  // Generate 252 furniture items with components and metadata
  const furnitureTypes = ['كرسي', 'طاولة', 'خزانة', 'سرير', 'أريكة', 'رف'];
  
  for (let i = 0; i < 252; i++) {
    const typeIndex = i % furnitureTypes.length;
    const categoryIndex = i % categories.length;
    const category = categories[categoryIndex];
    
    const sku = `FUR-${String(i + 1).padStart(5, '0')}`;
    const name = `${furnitureTypes[typeIndex]} ${category} #${i + 1}`;
    
    const components = [];
    const componentCount = (i % 5) + 1;
    for (let c = 0; c < componentCount; c++) {
      components.push({
        id: `comp-${i}-${c}`,
        name: `مكون ${c + 1}`,
        quantity: String(c + 1)
      });
    }

    items.push({
      sku,
      name,
      category,
      retailPrice: '250.000000',
      metadata: {
        category,
        description: `وصف ${name}`,
        components,
        pieces: componentCount
      }
    });
  }

  return {
    version: 'furniture-v1',
    items,
    warehouses
  };
}
