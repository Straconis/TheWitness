import { existsSync } from "node:fs";
import path from "node:path";
export function transcriptionConfig(){
 const bundled=path.resolve(__dirname,"../../bin"),executable=process.env.TRANSCRIPTION_EXECUTABLE?.trim()||(existsSync(path.join(bundled,"whisper-cli"))?path.join(bundled,"whisper-cli"):""),model=process.env.TRANSCRIPTION_MODEL?.trim()||(existsSync(path.join(bundled,"models/ggml-base.en.bin"))?path.join(bundled,"models/ggml-base.en.bin"):"");
 const threads=Number(process.env.TRANSCRIPTION_THREADS||"2"),timeoutMs=Number(process.env.TRANSCRIPTION_TIMEOUT_MINUTES||"30")*60000,language=process.env.TRANSCRIPTION_LANGUAGE?.trim()||"en",prompt=process.env.TRANSCRIPTION_PROMPT?.trim();
 if(!Number.isInteger(threads)||threads<1||threads>32||!Number.isFinite(timeoutMs)||timeoutMs<60000||timeoutMs>86400000||!/^([a-z]{2,3}|auto)$/.test(language)||(prompt&&prompt.length>2000))throw Error("Invalid transcription configuration.");
 return {executable,model,threads,timeoutMs,language,prompt};
}
export function transcriptionReady(){const config=transcriptionConfig();return !!config.executable&&!!config.model&&existsSync(config.executable)&&existsSync(config.model);}
