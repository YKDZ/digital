chrome.runtime.onInstalled.addListener(() => {});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
