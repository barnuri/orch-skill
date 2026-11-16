import Markdown from "../Markdown";

export default function MarkdownView({ text }: { text: string }) {
  return (
    <div className="art-md" data-testid="art-md">
      <Markdown text={text} />
    </div>
  );
}
