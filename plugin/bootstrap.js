var ZotAgentLocal;
var zotAgentChromeHandle;
async function startup({id,version,rootURI}){
  await Zotero.initializationPromise;
  const addonStartup=Components.classes['@mozilla.org/addons/addon-manager-startup;1'].getService(Components.interfaces.amIAddonManagerStartup);
  zotAgentChromeHandle=addonStartup.registerChrome(Services.io.newURI(rootURI+'manifest.json'),[['content','zotagent-local','./']]);
  Services.scriptloader.loadSubScript(rootURI+'main.js');
  ZotAgentLocal.init({id,version,rootURI});
  Zotero.ZotAgentLocal=ZotAgentLocal;
  for(const win of Zotero.getMainWindows())ZotAgentLocal.addToWindow(win);
  ZotAgentLocal.registerReaderHooks();
  Zotero.PreferencePanes.register({pluginID:id,label:'ZotAgent Local',image:rootURI+'icon.svg',src:rootURI+'preferences.xhtml'});
  if(Zotero.Prefs.get('extensions.zotagent-local.autoStart',true)!==false)ZotAgentLocal.connect().catch(e=>Zotero.logError(e));
}
function onMainWindowLoad({window}){ZotAgentLocal?.addToWindow(window);}
function onMainWindowUnload({window}){ZotAgentLocal?.removeFromWindow(window);}
async function shutdown(){await ZotAgentLocal?.shutdown();zotAgentChromeHandle?.destruct();zotAgentChromeHandle=undefined;delete Zotero.ZotAgentLocal;ZotAgentLocal=undefined;}
function install(){}
function uninstall(){}
