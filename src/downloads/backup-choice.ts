import {forcedBackups,backupLabel,SoundcraftBackupMode,SOUNDCRAFT_BACKUP_MODES} from "../exports/soundcraft-backup";

/** Ask shows a chooser; fixed modes only describe what the server includes; None shows nothing. Shared by every page that can export Soundcraft. */
export function backupChoiceHTML(mode:SoundcraftBackupMode):string{
 if(mode==="none")return "";
 if(mode==="ask")return `<div class="settings" id="backup-projects-choice"><label for="backup-projects">Optional backup projects for Soundcraft testing</label><select id="backup-projects"><option value="both" selected>Adobe Audition and Audacity</option><option value="audition">Adobe Audition only</option><option value="audacity">Audacity only</option><option value="none">Neither</option></select><p class="hint muted">Applies to Soundcraft exports. Adds fallback projects to the Soundcraft ZIP while Soundcraft support is being tested. They reuse the same speaker audio, so the download barely grows.</p></div>`;
 const projects=forcedBackups(mode)!;
 return `<p class="hint muted" id="backup-projects-note">Soundcraft exports also include an optional ${backupLabel(projects)} backup project${projects.length>1?"s":""} for Soundcraft testing. A server manager chose this in /dashboard.</p>`;
}
/** Markup for each mode, for pages that learn the mode after loading (the dashboard). */
export const backupChoiceVariants=Object.fromEntries(SOUNDCRAFT_BACKUP_MODES.map(mode=>[mode,backupChoiceHTML(mode)]));
/** Browser helper: the request field for a Soundcraft export; undefined for other formats and for fixed modes, which the server applies. */
export const backupChoiceScript=`
function selectedBackupProjects(mode,format){
 if(format!=='soundcraft'||mode!=='ask')return undefined;
 const choice=document.querySelector('#backup-projects')?.value;
 if(!['both','audition','audacity','none'].includes(choice))throw Error('Choose whether to include Soundcraft backup projects.');
 return choice==='both'?['audition','audacity']:choice==='none'?[]:[choice];
}
`;
