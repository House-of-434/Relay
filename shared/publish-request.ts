/** Display data for a local commit waiting for publication approval. */
export interface PublishRequestCardData {
  requestId: string;
  botId: string;
  repo: string;
  branch: string;
  commit: string;
  title: string;
  body: string;
  attachments: string[];
  diffStat: string;
}
