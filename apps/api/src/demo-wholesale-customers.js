// Fictional wholesale customers for development. No invented private phone numbers.
// Positive opening balance: customer owes us. Negative: we owe the customer.
export function demoWholesaleCustomers(){
 const brands=['النخيل','الرافدين','دجلة','الفرات','الورد','الياسمين','الرواد','الأمل','المنارة','الصفوة','الواحة','الربيع','الضياء','الدار','الكرم','روبي','ميلانو','لاله','فيرونا','حياة','الشرق','القمة','الندى','السندباد','السراي'];
 const places=[['بغداد','الكرخ','المنصور'],['البصرة','مركز البصرة','العشار'],['النجف','مركز النجف','حي الجامعة'],['كربلاء','مركز كربلاء','حي الحسين'],['بابل','الحلة','حي الزهراء'],['واسط','الكوت','حي الربيع']];
 const customers=[];
 for(const brand of brands)for(const [governorate,district,neighborhood] of places){const index=customers.length,balance=index<90?0:index<147?25+(index-90)%12*25:-[50,75,100][index-147];customers.push({code:'W-DEMO-'+String(index+1).padStart(3,'0'),name:'معرض '+brand+' — '+governorate,governorate,district,neighborhood,paymentPreference:balance>0?'credit':'cash',balance,currency:'USD',risk:balance>0?(index%15===0?'red':index%5===0?'yellow':'green'):'green'});}
 return {version:'wholesale-customers-v1',customers};
}
