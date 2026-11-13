// Browser-test substitution only. Never included in the production artifact.
export class PublicClientApplication {
 async initialize() {}
 getAllAccounts() { const saved=sessionStorage.getItem('test-account');return saved?[JSON.parse(saved)]:[]; }
 setActiveAccount() {}
 async loginPopup() { const account={homeAccountId:'test-account',name:'Test user'};sessionStorage.setItem('test-account',JSON.stringify(account));return {account}; }
 async acquireTokenSilent() { return {accessToken:'test-token'}; }
 async clearCache() { sessionStorage.removeItem('test-account'); }
}
