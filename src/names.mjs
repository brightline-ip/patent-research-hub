// Names that become folder or file names on Windows must not be reserved device names: CON, PRN, AUX, NUL, COM1-9 and
// LPT1-9 are reserved with or without an extension and with trailing dots or spaces ("con", "NUL.txt", "aux. "). A folder
// with such a name cannot be addressed by ordinary tools, so it could not be listed or deleted again.
const RESERVED=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export function isReservedDeviceName(name){
  if(typeof name!=='string')return false;
  const base=name.replace(/[. ]+$/,'').split('.')[0].replace(/[. ]+$/,'');
  return RESERVED.test(base);
}
export function assertNotReservedName(name,label='name'){
  if(isReservedDeviceName(name))throw new Error(`The ${label} "${name}" is a reserved Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9). Choose another ${label}.`);
  return name;
}
