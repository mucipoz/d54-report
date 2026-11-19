import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parseAllDocuments } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { report } from './static-utils.js';
import type { SourceFile, Issue } from '../types.js';

const pythonParser = `
import ast,json,sys
for i,source in enumerate(json.load(sys.stdin)):
    try:
        ast.parse(source)
    except SyntaxError as err:
        print(i,err.lineno or 1)
    except (ValueError,RecursionError):
        print(i,1)
`;
export function syntax(files: readonly SourceFile[]) {
  const notes: string[] = [], issues: Issue[] = [];
  const issue = (file: SourceFile,line:number,language:string) => issues.push(report(file,line,'errors','errors.syntax-'+language.toLowerCase(),'high',
    language+' sözdizimi hatası',language+' ayrıştırıcısı bu konumu okuyamadı.','Yükleme veya derleme durabilir.','Belirtilen konumdaki sözdizimini düzeltip yeniden doğrulayın.'));
  const py:SourceFile[]=[];
  for (const file of files) {
    if (!file.text) continue;
    if (/\.pyi?$/.test(file.path)) py.push(file);
    if (/\.ya?ml$/.test(file.path)) {
      try {
        for (const doc of parseAllDocuments(file.text,{strict:true,prettyErrors:false,logLevel:'silent'})) {
          if (doc.errors.length) {issue(file,file.text.slice(0,doc.errors[0].pos[0]).split('\n').length,'YAML');break;}
        }
      } catch {issue(file,1,'YAML');}
    }
    if (/\.toml$/.test(file.path)) {
      try {parseToml(file.text);}
      catch(e) {issue(file,Number((e as {line?:number}).line) || 1,'TOML');}
    }
  }
  for (let offset=0;offset<py.length;offset+=40) {
    const batch=py.slice(offset,offset+40);
    const processResult=spawnSync('python3',['-I','-S','-c',pythonParser],{cwd:tmpdir(),env:{PATH:process.env.PATH},
      input:JSON.stringify(batch.map(f=>f.text)),timeout:8_000,encoding:'utf8',maxBuffer:256_000});
    if (processResult.status!==0) {notes.push('Python AST sözdizimi taraması tamamlanamadı. python3 ve süreç sınırlarını kontrol edin.');break;}
    for (const line of processResult.stdout.trim().split('\n')) {
      const match=/^(\d+) (\d+)$/.exec(line);
      if (match && batch[Number(match[1])]) issue(batch[Number(match[1])],Number(match[2]),'Python');
    }
  }
  return {issues,notes};
}
