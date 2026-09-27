// Parse page metadata locally, off the UI thread. Never render or execute PDF actions.
importScripts('vendor/pdf-lib/pdf-lib-1.17.1.min.js');
self.onmessage = async ({data: file}) => {
  try {
    const pdf = await PDFLib.PDFDocument.load(await file.arrayBuffer(), {updateMetadata:false});
    self.postMessage({pages:pdf.getPageCount()});
  } catch {
    self.postMessage({pages:null});
  }
};
