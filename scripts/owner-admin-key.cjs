#!/usr/bin/env node
// Run as the bot's service user. The plaintext key is shown once, never stored.
const fs=require('node:fs'),path=require('node:path'),{randomBytes,createHash,randomUUID}=require('node:crypto');
const root=process.argv[2];if(!root||!path.isAbsolute(root)||!fs.statSync(root).isDirectory()){console.error('Usage: node scripts/owner-admin-key.cjs /absolute/recording/directory [--rotate]');process.exit(1);}
const file=path.join(root,'owner-login.json');if(fs.existsSync(file)&&!process.argv.includes('--rotate')){console.error('Owner backup sign-in already exists. Use --rotate to replace the key and invalidate existing sessions.');process.exit(1);}
const key=randomBytes(32).toString('base64url'),temporary=path.join(root,'.owner-login-'+randomUUID());
try{fs.writeFileSync(temporary,JSON.stringify({keyHash:createHash('sha256').update(key).digest('hex')}),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
console.log('Save this owner backup key in your password manager. It will not be shown again:');console.log(key);console.log('Sign in at your public bot URL followed by /admin.');
