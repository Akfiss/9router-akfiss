"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Modal, ConfirmModal, Toggle } from "@/shared/components";
import Input from "@/shared/components/Input";
import Pagination from "@/shared/components/Pagination";
import OneTimeKeyModal from "./OneTimeKeyModal";
import {
  validateUserForm,
  isKeyRevoked,
  buildUserLimitsPayload,
  fetchGatewayUsers,
  createGatewayUser,
  updateGatewayUser,
  deleteGatewayUser,
  fetchUserKeys,
  createUserKey,
  revokeUserKey,
  rotateUserKey,
} from "./UsersKeysTab.logic.js";

const EMPTY_USER_FORM = { name: "", requestsPerMinute: "", maxConcurrentRequests: "" };

export default function UsersKeysTab() {
  const [users, setUsers] = useState([]);
  const [usersPagination, setUsersPagination] = useState({ page: 1, pageSize: 10, totalItems: 0 });
  const [loadingUsers, setLoadingUsers] = useState(true);

  const [showCreateUser, setShowCreateUser] = useState(false);
  const [createForm, setCreateForm] = useState(EMPTY_USER_FORM);
  const [createError, setCreateError] = useState("");
  const [creatingUser, setCreatingUser] = useState(false);

  const [editingUser, setEditingUser] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_USER_FORM);
  const [editError, setEditError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const [selectedUser, setSelectedUser] = useState(null);
  const [keys, setKeys] = useState([]);
  const [keysPagination, setKeysPagination] = useState({ page: 1, pageSize: 10, totalItems: 0 });
  const [loadingKeys, setLoadingKeys] = useState(false);

  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);

  const [createdKey, setCreatedKey] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revoking, setRevoking] = useState(false);
  const [rotatingKeyId, setRotatingKeyId] = useState(null);
  const [actionError, setActionError] = useState("");

  // Separate from actionError, which only renders inside the Keys card — a
  // delete can be triggered with no user selected, so its failure needs a
  // home in the Users card or it would be invisible.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingUser, setDeletingUser] = useState(false);
  const [usersError, setUsersError] = useState("");

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const data = await fetchGatewayUsers({ page: usersPagination.page, pageSize: usersPagination.pageSize });
      setUsers(data.users || []);
      setUsersPagination((prev) => ({ ...prev, ...data.pagination }));
    } catch (error) {
      console.error("Failed to fetch Bansos users:", error);
    } finally {
      setLoadingUsers(false);
    }
  }, [usersPagination.page, usersPagination.pageSize]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadUsers();
  }, [loadUsers]);

  const loadKeys = useCallback(async (userId, page, pageSize) => {
    if (!userId) return;
    setLoadingKeys(true);
    try {
      const data = await fetchUserKeys(userId, { page, pageSize });
      setKeys(data.keys || []);
      setKeysPagination((prev) => ({ ...prev, ...data.pagination }));
    } catch (error) {
      console.error("Failed to fetch Bansos keys:", error);
    } finally {
      setLoadingKeys(false);
    }
  }, []);

  useEffect(() => {
    if (selectedUser) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadKeys(selectedUser.id, keysPagination.page, keysPagination.pageSize);
    }
  }, [selectedUser, keysPagination.page, keysPagination.pageSize, loadKeys]);

  const handleSelectUser = (user) => {
    setSelectedUser(user);
    setKeysPagination((prev) => ({ ...prev, page: 1 }));
    setActionError("");
  };

  const handleCreateUser = async () => {
    const error = validateUserForm(createForm);
    if (error) {
      setCreateError(error);
      return;
    }
    setCreatingUser(true);
    setCreateError("");
    try {
      const payload = { name: createForm.name.trim(), ...buildUserLimitsPayload(createForm) };

      const res = await createGatewayUser(payload);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateError(data.error || "Failed to create user");
        return;
      }

      setShowCreateUser(false);
      setCreateForm(EMPTY_USER_FORM);
      await loadUsers();
    } catch (error) {
      setCreateError("An error occurred");
    } finally {
      setCreatingUser(false);
    }
  };

  const openEdit = (user) => {
    setEditingUser(user);
    setEditForm({
      name: user.name,
      requestsPerMinute: String(user.requestsPerMinute ?? ""),
      maxConcurrentRequests: String(user.maxConcurrentRequests ?? ""),
      isActive: user.isActive,
    });
    setEditError("");
  };

  const handleSaveEdit = async () => {
    const error = validateUserForm(editForm);
    if (error) {
      setEditError(error);
      return;
    }
    setSavingEdit(true);
    setEditError("");
    try {
      const patch = {
        name: editForm.name.trim(),
        isActive: editForm.isActive,
        ...buildUserLimitsPayload(editForm),
      };
      const res = await updateGatewayUser(editingUser.id, patch);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEditError(data.error || "Failed to update user");
        return;
      }

      setUsers((prev) => prev.map((u) => (u.id === data.user.id ? data.user : u)));
      setSelectedUser((prev) => (prev?.id === data.user.id ? data.user : prev));
      setEditingUser(null);
    } catch (error) {
      setEditError("An error occurred");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleCreateKey = async () => {
    if (!newKeyName.trim() || !selectedUser) return;
    setCreatingKey(true);
    setActionError("");
    try {
      const res = await createUserKey(selectedUser.id, newKeyName.trim());
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(data.error || "Failed to create key");
        return;
      }

      setCreatedKey(data.key);
      setShowCreateKey(false);
      setNewKeyName("");
      await loadKeys(selectedUser.id, keysPagination.page, keysPagination.pageSize);
    } catch (error) {
      setActionError("An error occurred");
    } finally {
      setCreatingKey(false);
    }
  };

  const handleRotate = async (key) => {
    if (!selectedUser) return;
    setRotatingKeyId(key.id);
    setActionError("");
    try {
      const res = await rotateUserKey(key.id, selectedUser.id, key.name);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(data.error || "Failed to rotate key");
        return;
      }

      setCreatedKey(data.key);
      await loadKeys(selectedUser.id, keysPagination.page, keysPagination.pageSize);
    } catch (error) {
      setActionError("An error occurred");
    } finally {
      setRotatingKeyId(null);
    }
  };

  const handleRevokeConfirm = async () => {
    if (!revokeTarget || !selectedUser) return;
    setRevoking(true);
    try {
      const res = await revokeUserKey(revokeTarget.id, selectedUser.id);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.key) {
        setKeys((prev) => prev.map((k) => (k.id === data.key.id ? data.key : k)));
      } else if (!res.ok) {
        setActionError(data.error || "Failed to revoke key");
      }
      setRevokeTarget(null);
    } catch (error) {
      setActionError("An error occurred");
    } finally {
      setRevoking(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeletingUser(true);
    setUsersError("");
    try {
      const res = await deleteGatewayUser(deleteTarget.id);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUsersError(data.error || "Failed to delete user");
        return;
      }

      // The Keys card renders off selectedUser; leaving it pointed at a
      // deleted user would keep showing keys that no longer exist.
      if (selectedUser?.id === deleteTarget.id) {
        setSelectedUser(null);
        setKeys([]);
        setActionError("");
      }

      // Deleting the only row on a trailing page would otherwise strand the
      // admin on an empty page. Stepping back re-runs loadUsers via the
      // page effect, so don't also call it here.
      if (users.length === 1 && usersPagination.page > 1) {
        setUsersPagination((prev) => ({ ...prev, page: prev.page - 1 }));
      } else {
        await loadUsers();
      }
    } catch (error) {
      setUsersError("An error occurred");
    } finally {
      setDeletingUser(false);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card
        title="Gateway Users"
        icon="group"
        padding="md"
        action={
          <Button size="sm" icon="add" onClick={() => setShowCreateUser(true)}>
            New User
          </Button>
        }
      >
        {usersError && <p className="pb-3 text-sm text-red-500">{usersError}</p>}
        {loadingUsers ? (
          <div className="p-8 text-center text-text-muted">Loading...</div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-text-muted">No users yet</div>
        ) : (
          users.map((user) => (
            <Card.ListItem
              key={user.id}
              actions={
                <>
                  <Button size="sm" variant="ghost" onClick={() => handleSelectUser(user)}>
                    Keys
                  </Button>
                  <Button size="sm" variant="ghost" icon="edit" onClick={() => openEdit(user)} />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="delete"
                    onClick={() => {
                      setUsersError("");
                      setDeleteTarget(user);
                    }}
                  />
                </>
              }
            >
              <div className="flex items-center gap-3">
                <div>
                  <p className="font-medium text-sm text-text-main">{user.name}</p>
                  <p className="text-xs text-text-muted">
                    {user.requestsPerMinute} req/min &middot; {user.maxConcurrentRequests} concurrent
                  </p>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded shrink-0 ${
                    user.isActive ? "bg-green-500/15 text-green-600" : "bg-surface-2 text-text-muted"
                  }`}
                >
                  {user.isActive ? "Active" : "Inactive"}
                </span>
              </div>
            </Card.ListItem>
          ))
        )}
        <Pagination
          currentPage={usersPagination.page}
          pageSize={usersPagination.pageSize}
          totalItems={usersPagination.totalItems}
          onPageChange={(page) => setUsersPagination((prev) => ({ ...prev, page }))}
          onPageSizeChange={(pageSize) => setUsersPagination((prev) => ({ ...prev, pageSize, page: 1 }))}
        />
      </Card>

      {selectedUser && (
        <Card
          title={`Keys — ${selectedUser.name}`}
          icon="vpn_key"
          padding="md"
          action={
            <Button size="sm" icon="add" onClick={() => setShowCreateKey(true)}>
              New Key
            </Button>
          }
        >
          {actionError && <p className="pb-3 text-sm text-red-500">{actionError}</p>}
          {loadingKeys ? (
            <div className="p-8 text-center text-text-muted">Loading...</div>
          ) : keys.length === 0 ? (
            <div className="p-8 text-center text-text-muted">No keys yet</div>
          ) : (
            keys.map((key) => {
              const revoked = isKeyRevoked(key);
              return (
                <Card.ListItem
                  key={key.id}
                  actions={
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={rotatingKeyId === key.id}
                        disabled={revoked}
                        onClick={() => handleRotate(key)}
                      >
                        Rotate
                      </Button>
                      <Button size="sm" variant="ghost" disabled={revoked} onClick={() => setRevokeTarget(key)}>
                        Revoke
                      </Button>
                    </>
                  }
                >
                  <div>
                    <p className="font-medium text-sm text-text-main">{key.name}</p>
                    <p className="text-xs font-mono text-text-muted">{key.keyPrefix}</p>
                    <p className="text-xs text-text-muted">
                      {revoked
                        ? `Revoked ${new Date(key.revokedAt).toLocaleString()}`
                        : key.lastUsedAt
                          ? `Last used ${new Date(key.lastUsedAt).toLocaleString()}`
                          : "Never used"}
                    </p>
                  </div>
                </Card.ListItem>
              );
            })
          )}
          <Pagination
            currentPage={keysPagination.page}
            pageSize={keysPagination.pageSize}
            totalItems={keysPagination.totalItems}
            onPageChange={(page) => setKeysPagination((prev) => ({ ...prev, page }))}
            onPageSizeChange={(pageSize) => setKeysPagination((prev) => ({ ...prev, pageSize, page: 1 }))}
          />
        </Card>
      )}

      {/* Create user modal */}
      <Modal
        isOpen={showCreateUser}
        title="New Gateway User"
        onClose={() => {
          setShowCreateUser(false);
          setCreateError("");
        }}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            value={createForm.name}
            onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Dinsos Jakarta"
          />
          <Input
            label="Requests / Minute (optional)"
            type="number"
            min="1"
            value={createForm.requestsPerMinute}
            onChange={(e) => setCreateForm((f) => ({ ...f, requestsPerMinute: e.target.value }))}
            placeholder="Uses gateway default"
          />
          <Input
            label="Max Concurrent Requests (optional)"
            type="number"
            min="1"
            value={createForm.maxConcurrentRequests}
            onChange={(e) => setCreateForm((f) => ({ ...f, maxConcurrentRequests: e.target.value }))}
            placeholder="Uses gateway default"
          />
          {createError && <p className="text-sm text-red-500">{createError}</p>}
          <Button onClick={handleCreateUser} loading={creatingUser} fullWidth>
            Create
          </Button>
        </div>
      </Modal>

      {/* Edit user modal */}
      <Modal isOpen={!!editingUser} title="Edit Gateway User" onClose={() => setEditingUser(null)}>
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            value={editForm.name}
            onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
          />
          <Input
            label="Requests / Minute"
            type="number"
            min="1"
            value={editForm.requestsPerMinute}
            onChange={(e) => setEditForm((f) => ({ ...f, requestsPerMinute: e.target.value }))}
          />
          <Input
            label="Max Concurrent Requests"
            type="number"
            min="1"
            value={editForm.maxConcurrentRequests}
            onChange={(e) => setEditForm((f) => ({ ...f, maxConcurrentRequests: e.target.value }))}
          />
          <Toggle
            checked={!!editForm.isActive}
            onChange={(v) => setEditForm((f) => ({ ...f, isActive: v }))}
            label="Active"
          />
          {editError && <p className="text-sm text-red-500">{editError}</p>}
          <Button onClick={handleSaveEdit} loading={savingEdit} fullWidth>
            Save
          </Button>
        </div>
      </Modal>

      {/* Create key modal */}
      <Modal
        isOpen={showCreateKey}
        title="New API Key"
        onClose={() => {
          setShowCreateKey(false);
          setNewKeyName("");
        }}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Key Name"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Production Key"
          />
          <Button onClick={handleCreateKey} loading={creatingKey} disabled={!newKeyName.trim()} fullWidth>
            Create
          </Button>
        </div>
      </Modal>

      <OneTimeKeyModal keyRecord={createdKey} onClose={() => setCreatedKey(null)} />

      <ConfirmModal
        isOpen={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevokeConfirm}
        title="Revoke API Key"
        message={`Revoke "${revokeTarget?.name}"? Any client using this key will immediately lose access.`}
        confirmText="Revoke"
        cancelText="Cancel"
        variant="danger"
        loading={revoking}
      />

      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
        title="Delete Gateway User"
        message={`Permanently delete "${deleteTarget?.name}" and every API key they own? Clients using those keys lose access immediately and this cannot be undone. Their request history and usage records are kept. To suspend access without deleting anything, edit the user and turn off Active instead.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        loading={deletingUser}
      />
    </div>
  );
}
