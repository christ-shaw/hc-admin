export type AnnouncementStatus = 'draft' | 'published' | 'archived';

export interface FeatureAnnouncement {
  _id: string;
  title: string;
  versionLabel?: string;
  summary?: string;
  content: string;
  actionPath?: string;
  status: AnnouncementStatus;
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  read?: boolean;
  readAt?: string;
}

export interface ManageAnnouncementsResult {
  success: boolean;
  data?: FeatureAnnouncement[] | FeatureAnnouncement;
  errMsg?: string;
}
