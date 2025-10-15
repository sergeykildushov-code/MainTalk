// custom/urlDebug.js
const { getWindowUrl } = require('../app/utils.ts');

function debugUrlLoading(appData) {
  console.log('=== URL DEBUG INFO ===');
  console.log('AppData serverUrl:', appData.serverUrl);
  console.log('AppData credentials:', appData.credentials ? 'PRESENT' : 'MISSING');
  
  try {
    const talkUrl = getWindowUrl('talk') + '#/apps/spreed';
    console.log('Final Talk URL:', talkUrl);
    return talkUrl;
  } catch (error) {
    console.error('Error generating Talk URL:', error);
    return null;
  }
}

module.exports = { debugUrlLoading };