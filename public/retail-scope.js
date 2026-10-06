// Dedicated browser storage namespace for the retail product on a shared origin.
(()=>{const prefix='almahasib-retail:';const get=Storage.prototype.getItem,set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
Storage.prototype.getItem=function(key){return get.call(this,prefix+key);};
Storage.prototype.setItem=function(key,value){return set.call(this,prefix+key,value);};
Storage.prototype.removeItem=function(key){return remove.call(this,prefix+key);};
})();
