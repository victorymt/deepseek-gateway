import { useCallback } from "react"
import {
  ArchiveIcon,
  DatabaseIcon,
  DownloadIcon,
  Trash2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { StorageInfo } from "@/gateway-types"
import { apiRequest } from "@/lib/api-request"

import { ConfirmAction, OperationsPageShell } from "./page-shell"
import { useOperationsPage } from "./page-state"
import type { OperationsPageProps } from "./types"

export default function StoragePage({ locale, active }: OperationsPageProps) {
  const zh = locale === "zh-CN"
  const load = useCallback(
    (signal: AbortSignal) =>
      apiRequest<StorageInfo>("/api/storage", { signal }),
    []
  )
  const page = useOperationsPage<StorageInfo | null>(load, active, null)
  const storage = page.data

  return (
    <OperationsPageShell
      kind="storage"
      locale={locale}
      loading={page.loading}
      error={page.error}
      notice={page.notice}
      onRefresh={() => void page.refresh()}
    >
      {storage && (
        <Card>
          <CardHeader>
            <div className="operation-row">
              <CardTitle>
                <DatabaseIcon />
                {zh ? "配置存储" : "Configuration storage"}
              </CardTitle>
              <Button
                size="sm"
                disabled={Boolean(page.pendingAction)}
                onClick={() =>
                  void page.action(
                    "/api/storage",
                    {
                      method: "POST",
                      body: JSON.stringify({ action: "backup" }),
                    },
                    zh ? "备份已创建" : "Backup created"
                  )
                }
              >
                <ArchiveIcon data-icon="inline-start" />
                {zh ? "创建备份" : "Create backup"}
              </Button>
            </div>
            <CardDescription>{storage.configPath}</CardDescription>
          </CardHeader>
          <CardContent>
            <p>
              {storage.configSize.toLocaleString(locale)} bytes ·{" "}
              {zh
                ? `保留 ${storage.retention.backupLimit} 个备份`
                : `keep ${storage.retention.backupLimit} backups`}
            </p>
            <div className="backup-list">
              {storage.backups.map((backup) => (
                <div className="operation-row" key={backup.id}>
                  <span>
                    {new Date(backup.createdAt).toLocaleString(locale)}
                  </span>
                  <span>
                    <ConfirmAction
                      zh={zh}
                      title={zh ? "恢复配置？" : "Restore configuration?"}
                      description={
                        zh
                          ? "当前配置会先自动备份。"
                          : "The current configuration will be backed up first."
                      }
                      action={() =>
                        void page.action(
                          "/api/storage",
                          {
                            method: "POST",
                            body: JSON.stringify({
                              action: "restore",
                              id: backup.id,
                            }),
                          },
                          zh ? "配置已恢复" : "Configuration restored"
                        )
                      }
                    >
                      <DownloadIcon data-icon="inline-start" />
                      {zh ? "恢复" : "Restore"}
                    </ConfirmAction>
                    <ConfirmAction
                      zh={zh}
                      title={zh ? "删除备份？" : "Delete backup?"}
                      description={backup.id}
                      destructive
                      action={() =>
                        void page.action(
                          `/api/storage/backups/${encodeURIComponent(backup.id)}`,
                          { method: "DELETE" },
                          zh ? "备份已删除" : "Backup deleted"
                        )
                      }
                    >
                      <Trash2Icon />
                    </ConfirmAction>
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </OperationsPageShell>
  )
}
