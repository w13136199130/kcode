import fs from 'node:fs';
const edit=(p,f)=>fs.writeFileSync(p,f(fs.readFileSync(p,'utf8').replaceAll('\r\n','\n')));
edit('apps/cli/src/tui/App.tsx',s=>{
 s='import { previousBoundary, nextBoundary, truncateVisual } from "./width.js";\n'+s;
 const start=s.indexOf('  /** IME 组合区起点');const end=s.indexOf('  const pos =',start);
 s=s.slice(0,start)+s.slice(end);
 const a=s.indexOf('  /**\n   * IME 组合区跟踪');const b=s.indexOf('  const menuOpen =',a);
 if(a<0||b<0)throw Error('missing input');
 s=s.slice(0,a)+`  // 终端没有可靠的 DOM composition 事件：保留收到的文字，不猜拼音，不丢数字。
  const clearTail = (): void => {};
  const trimTailTo = (_at: number): void => {};
  const insertText = (str: string): void => {
    const text = str.replace(/\\r\\n?/g, "\\n");
    setValue(props.value.slice(0, pos) + text + props.value.slice(pos), pos + text.length);
  };
`+s.slice(b);
 s=s.replace(/      if \(process\.env\["VITEST"\] === "true"\) \{[\s\S]*?\n      \}/,'');
 s=s.replaceAll('pos - 1','previousBoundary(props.value, pos)').replaceAll('pos + 1','nextBoundary(props.value, pos)');
 s=s.replace('\\n${props.value.slice(pos)}`, nextBoundary(props.value, pos))','\\n${props.value.slice(pos)}`, pos + 1)');
 s=s.replace('line.slice(cursorCol + 1)','line.slice(cursorCol)');
 s=s.replace('setValue((s) => s.slice(0, -1))','setValue((s) => s.slice(0, previousBoundary(s, s.length)))');
 s=s.replaceAll('line.slice(0, 120)','truncateVisual(line, 120)');
 return s;
});
edit('apps/cli/src/tui/Transcript.tsx',s=>s.replace('import { visualWidth, wrapVisual }','import { visualWidth, wrapVisual, truncateVisual }').replaceAll('line.slice(0, 120)','truncateVisual(line, 120)'));
edit('apps/cli/test/input-ime.test.tsx',s=>s.replace('中文上屏后选词数字不泄漏（护栏内丢弃）','中文后正常输入数字必须保留').replace('t.stdin.write("n");','t.stdin.write("api");').replace('expect(frame).not.toContain("你好1");','expect(frame).toContain("api你好1");').replace(' // 1.2s 护栏内：应被丢弃',' // 紧接中文的数字是合法输入'));
