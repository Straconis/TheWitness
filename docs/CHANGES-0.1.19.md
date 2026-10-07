# 0.1.19 — avoid duplicate export failure logs

Attachment-mode export failures now rely on the queue's diagnostic log instead of logging the same job error again. The Discord failure reply still identifies the job, preserves the recording and provides the status command.

Documented that disconnecting saved cloud credentials does not remove configured environment tokens. A configured refresh token can recreate saved credentials on the next upload. Fully disabling the connection requires removing the provider's environment tokens and restarting the bot as well as disconnecting saved credentials. Credential behavior is unchanged.
