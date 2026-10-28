"""Independent reader for the UTF-8 string-attribute subset used by Witness's AUP3 writer."""
import sqlite3,struct,xml.etree.ElementTree as ET

def native_project(filename):
 c=sqlite3.connect(filename);assert c.execute('pragma integrity_check').fetchone()[0]=='ok'
 assert c.execute('pragma application_id').fetchone()[0]==0x41554459
 d,b=c.execute('select dict,doc from project').fetchone();assert d[:2]==bytes([0,1]);names={};p=2
 while p<len(d):
  assert d[p]==15;i,n=struct.unpack_from('<HH',d,p+1);p+=5;names[i]=d[p:p+n].decode();p+=n
 stack=[];root=None;p=0
 while p<len(b):
  t=b[p];i=struct.unpack_from('<H',b,p+1)[0];p+=3
  if t==1:
   e=ET.Element(names[i]);
   if stack:stack[-1].append(e)
   else:root=e
   stack.append(e)
  elif t==2:assert stack.pop().tag==names[i]
  elif t==3:
   n=struct.unpack_from('<i',b,p)[0];p+=4;stack[-1].set(names[i],b[p:p+n].decode());p+=n
  else:raise AssertionError(t)
 assert not stack
 return c,root
