// Some Windows editors (older Notepad) save UTF-8 files with a byte order mark. JSON.parse rejects it, so it is removed
// from every JSON file that a person may edit by hand.
export const stripBom=text=>typeof text==='string'&&text.charCodeAt(0)===0xFEFF?text.slice(1):text;
export const parseJsonText=text=>JSON.parse(stripBom(text));