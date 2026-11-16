import type {
  AttachmentDto,
  ChatDto,
  ChatOptionsDto,
  FolderListDto,
  HarnessOptionDto,
  MessageDto,
  ModelOptionDto,
  ProfileOptionDto,
  ProjectDto,
  SearchHitDto,
} from "../../shared/dto/chats";

export type Chat = ChatDto;
export type Project = ProjectDto;
export type Message = MessageDto;
export type FolderList = FolderListDto;
export type Attachment = AttachmentDto;
export type SearchHit = SearchHitDto;
export type ChatOptions = ChatOptionsDto;
export type HarnessOption = HarnessOptionDto;
export type ProfileOption = ProfileOptionDto;
export type ModelOption = ModelOptionDto;

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
