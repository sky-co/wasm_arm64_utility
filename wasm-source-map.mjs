function entriesForSection(bytes, section) {
  let offset = section.start;
  function leb() {
    let value = 0;
    let scale = 1;
    for (let count = 0; count < 10 && offset < section.end; count++) {
      const byte = bytes[offset++];
      value += (byte & 0x7f) * scale;
      if (!(byte & 0x80)) return value;
      scale *= 128;
    }
    throw new Error(`Invalid LEB128 in ${section.name} section.`);
  }
  function valueType() {
    const type = bytes[offset++];
    if (type === 0x63 || type === 0x64) {
      leb();
      return true;
    }
    return type >= 0x69 && type <= 0x7f;
  }
  function limits() {
    const flags = leb();
    if (flags & ~7) return false;
    leb();
    if (flags & 1) leb();
    return true;
  }
  function name() {
    const length = leb();
    offset += length;
  }
  const count = leb();
  const entries = [];
  for (let index = 0; index < count; index++) {
    const start = index === 0 ? section.start : offset;
    switch (section.name) {
      case 'Type': {
        if (bytes[offset++] !== 0x60) return null;
        const parameters = leb();
        for (let i = 0; i < parameters; i++) if (!valueType()) return null;
        const results = leb();
        for (let i = 0; i < results; i++) if (!valueType()) return null;
        break;
      }
      case 'Import': {
        name();
        name();
        const kind = bytes[offset++];
        if (kind === 0) leb();
        else if (kind === 1) {
          if (!valueType() || !limits()) return null;
        } else if (kind === 2) {
          if (!limits()) return null;
        } else if (kind === 3) {
          if (!valueType()) return null;
          offset++;
        } else if (kind === 4) {
          offset++;
          leb();
        } else return null;
        break;
      }
      case 'Function':
        leb();
        break;
      case 'Table':
        if (!valueType() || !limits()) return null;
        break;
      case 'Memory':
        if (!limits()) return null;
        break;
      case 'Export':
        name();
        offset++;
        leb();
        break;
      case 'Code': {
        const size = leb();
        const end = offset + size;
        if (end > section.end) throw new Error('Function body exceeds Code section.');
        entries.push({ start, end });
        offset = end;
        continue;
      }
      default:
        return null;
    }
    if (offset > section.end) throw new Error(`Entry exceeds ${section.name} section.`);
    entries.push({ start, end: offset });
  }
  return offset === section.end ? entries : null;
}

function instructionRanges(disassembly, bodies) {
  const functions = [];
  let current;
  for (const line of disassembly.split('\n')) {
    if (/^[0-9a-f]+ func\[\d+\]/i.test(line)) {
      current = { instructions: [] };
      functions.push(current);
      continue;
    }
    const match = /^\s*([0-9a-f]+):\s+(?:[0-9a-f]{2}\s+)+\|\s+([a-z0-9_.]+)/i.exec(line);
    if (!match || !current || match[2] === 'local') continue;
    current.instructions.push({ start: Number.parseInt(match[1], 16), mnemonic: match[2] });
  }
  for (const [index, func] of functions.entries()) {
    const body = bodies?.[index];
    if (!body) continue;
    func.header = { start: body.start, end: func.instructions[0]?.start ?? body.end };
    for (const [i, instruction] of func.instructions.entries()) {
      instruction.end = func.instructions[i + 1]?.start ?? body.end;
    }
  }
  return functions;
}

export function buildWatSourceMap(bytes, sections, wat, disassembly) {
  const sectionByName = new Map(sections.map(section => [section.name, section]));
  const exactEntries = new Map();
  for (const section of sections) {
    if (['Type', 'Import', 'Function', 'Table', 'Memory', 'Export', 'Code'].includes(section.name)) {
      exactEntries.set(section.name, entriesForSection(bytes, section));
    }
  }
  const functions = instructionRanges(disassembly, exactEntries.get('Code'));
  const indices = new Map();
  const declarationSections = {
    type: 'Type', import: 'Import', func: 'Code', table: 'Table', memory: 'Memory',
    global: 'Global', export: 'Export', start: 'Start', elem: 'Elem', data: 'Data', tag: 'Tag',
  };
  let currentFunction;
  let instructionIndex = 0;
  return wat.split('\n').map((text, line) => {
    const mapping = { line, ranges: [], granularity: 'none' };
    if (text === '(module') {
      return { ...mapping, ranges: [{ start: 0, end: 8 }], granularity: 'module' };
    }
    const declaration = /^ {2}\(([a-z]+)\b/.exec(text);
    if (declaration) {
      currentFunction = null;
      const kind = declaration[1];
      const name = declarationSections[kind];
      const section = sectionByName.get(name);
      if (!section) return mapping;
      const index = indices.get(name) || 0;
      indices.set(name, index + 1);
      let range = exactEntries.get(name)?.[index];
      if (kind === 'func') {
        currentFunction = functions[index];
        instructionIndex = 0;
        range = currentFunction?.header;
        const signature = exactEntries.get('Function')?.[index];
        if (signature) mapping.ranges.push(signature);
      }
      mapping.ranges.push(range || { start: section.start, end: section.end });
      mapping.granularity = range ? 'entry' : 'section';
      return mapping;
    }
    if (currentFunction) {
      if (/^\s+\(local\b/.test(text)) {
        return { ...mapping, ranges: [currentFunction.header], granularity: 'entry' };
      }
      const mnemonic = /^\s+([a-z][a-z0-9_.]*)\b/.exec(text)?.[1];
      const instruction = currentFunction.instructions[instructionIndex];
      if (mnemonic && instruction?.mnemonic === mnemonic) {
        instructionIndex++;
        return { ...mapping, ranges: [{ start: instruction.start, end: instruction.end }], granularity: 'instruction' };
      }
    }
    return mapping;
  });
}
