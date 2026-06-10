import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { PlusIcon, CheckIcon, ClockIcon, ExclamationTriangleIcon, PencilSquareIcon, TrashIcon, PlayIcon } from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';
import type { MarketingTask } from '../../features/marketing/types';
import { fmtDate } from '../../features/marketing/utils/format';

const priorityColors: Record<string, string> = {
  LOW: 'text-gray-500',
  MEDIUM: 'text-blue-600',
  HIGH: 'text-orange-600',
  URGENT: 'text-red-600',
};

const statusIcons: Record<string, React.ElementType> = {
  PENDING: ClockIcon,
  IN_PROGRESS: ClockIcon,
  COMPLETED: CheckIcon,
};

export default function TasksPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [tab, setTab] = useState<'all' | 'today' | 'overdue'>('all');
  const [showForm, setShowForm] = useState(false);
  const [newTask, setNewTask] = useState({
    title: '',
    type: 'FOLLOW_UP',
    priority: 'MEDIUM',
    dueDate: new Date().toISOString().split('T')[0],
    description: '',
  });
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    title: '',
    type: 'FOLLOW_UP',
    priority: 'MEDIUM',
    dueDate: '',
    description: '',
  });

  const queryKey = tab === 'today'
    ? ['marketing', 'tasks', 'today']
    : tab === 'overdue'
    ? ['marketing', 'tasks', 'overdue']
    : ['marketing', 'tasks', { status }];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => {
      if (tab === 'today') return marketingApi.get('/tasks/today').then((r) => r.data);
      if (tab === 'overdue') return marketingApi.get('/tasks/overdue').then((r) => r.data);
      return marketingApi.get('/tasks', { params: { status: status || undefined } }).then((r) => r.data?.data || r.data);
    },
  });

  const completeMutation = useMutation({
    mutationFn: (taskId: string) => marketingApi.patch(`/tasks/${taskId}/complete`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'tasks'] });
      toast.success('Task completed');
    },
    onError: () => {
      toast.error('Failed to complete task');
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => marketingApi.post('/tasks', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'tasks'] });
      setShowForm(false);
      setNewTask({ title: '', type: 'FOLLOW_UP', priority: 'MEDIUM', dueDate: new Date().toISOString().split('T')[0], description: '' });
      toast.success('Task created');
    },
    onError: () => {
      toast.error('Failed to create task');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      marketingApi.patch(`/tasks/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'tasks'] });
      setEditingTaskId(null);
      toast.success('Task updated');
    },
    onError: () => {
      toast.error('Failed to update task');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/tasks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'tasks'] });
      toast.success('Task deleted');
    },
    onError: () => {
      toast.error('Failed to delete task');
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      marketingApi.patch(`/tasks/${id}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'tasks'] });
      toast.success('Task status updated');
    },
    onError: () => {
      toast.error('Failed to update task status');
    },
  });

  const startEditing = (task: MarketingTask) => {
    setEditingTaskId(task.id);
    setEditForm({
      title: task.title,
      type: task.type,
      priority: task.priority,
      dueDate: task.dueDate ? task.dueDate.split('T')[0] : '',
      description: task.description || '',
    });
  };

  const tasks = Array.isArray(data) ? data : data?.data || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Tasks</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90"
        >
          <PlusIcon className="w-4 h-4" />
          New Task
        </button>
      </div>

      {/* Quick add form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              type="text"
              placeholder="Task title"
              value={newTask.title}
              onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
              className="sm:col-span-2 px-3 py-2 border rounded-lg text-sm"
            />
            <select
              value={newTask.type}
              onChange={(e) => setNewTask({ ...newTask, type: e.target.value })}
              className="px-3 py-2 border rounded-lg text-sm"
            >
              <option value="CALL">Call</option>
              <option value="VISIT">Visit</option>
              <option value="DEMO">Demo</option>
              <option value="FOLLOW_UP">Follow Up</option>
              <option value="MEETING">Meeting</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              type="date"
              value={newTask.dueDate}
              onChange={(e) => setNewTask({ ...newTask, dueDate: e.target.value })}
              className="px-3 py-2 border rounded-lg text-sm"
            />
            <select
              value={newTask.priority}
              onChange={(e) => setNewTask({ ...newTask, priority: e.target.value })}
              className="px-3 py-2 border rounded-lg text-sm"
            >
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
              <option value="URGENT">Urgent</option>
            </select>
            <div className="flex gap-2">
              <button
                onClick={() => createMutation.mutate(newTask)}
                disabled={!newTask.title || createMutation.isPending}
                className="flex-1 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                Create
              </button>
              <button onClick={() => setShowForm(false)} className="px-4 py-2 border rounded-lg text-sm">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2">
        {(['all', 'today', 'overdue'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium capitalize ${
              tab === t ? 'bg-primary/15 text-primary' : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {t === 'overdue' && <ExclamationTriangleIcon className="w-4 h-4 inline mr-1" />}
            {t}
          </button>
        ))}
      </div>

      {/* Task list */}
      <div className="bg-white rounded-xl border border-gray-200 divide-y">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : tasks.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No tasks found</div>
        ) : (
          tasks.map((task: MarketingTask) => {
            const isOverdue = new Date(task.dueDate) < new Date() && task.status !== 'COMPLETED';

            if (editingTaskId === task.id) {
              return (
                <div key={task.id} className="p-4 bg-gray-50 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <input
                      type="text"
                      placeholder="Task title"
                      value={editForm.title}
                      onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                      className="sm:col-span-2 px-3 py-2 border rounded-lg text-sm"
                    />
                    <select
                      value={editForm.type}
                      onChange={(e) => setEditForm({ ...editForm, type: e.target.value })}
                      className="px-3 py-2 border rounded-lg text-sm"
                    >
                      <option value="CALL">Call</option>
                      <option value="VISIT">Visit</option>
                      <option value="DEMO">Demo</option>
                      <option value="FOLLOW_UP">Follow Up</option>
                      <option value="MEETING">Meeting</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <input
                      type="date"
                      value={editForm.dueDate}
                      onChange={(e) => setEditForm({ ...editForm, dueDate: e.target.value })}
                      className="px-3 py-2 border rounded-lg text-sm"
                    />
                    <select
                      value={editForm.priority}
                      onChange={(e) => setEditForm({ ...editForm, priority: e.target.value })}
                      className="px-3 py-2 border rounded-lg text-sm"
                    >
                      <option value="LOW">Low</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="HIGH">High</option>
                      <option value="URGENT">Urgent</option>
                    </select>
                    <input
                      type="text"
                      placeholder="Description (optional)"
                      value={editForm.description}
                      onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                      className="px-3 py-2 border rounded-lg text-sm"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() =>
                        updateMutation.mutate({
                          id: task.id,
                          data: {
                            title: editForm.title,
                            type: editForm.type,
                            priority: editForm.priority,
                            dueDate: editForm.dueDate,
                            description: editForm.description || undefined,
                          },
                        })
                      }
                      disabled={!editForm.title || updateMutation.isPending}
                      className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditingTaskId(null)}
                      className="px-4 py-2 border rounded-lg text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div key={task.id} className="flex items-center gap-4 p-4 hover:bg-gray-50">
                <button
                  onClick={() => task.status !== 'COMPLETED' && completeMutation.mutate(task.id)}
                  disabled={task.status === 'COMPLETED'}
                  className={`w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                    task.status === 'COMPLETED'
                      ? 'bg-green-500 border-green-500 text-white'
                      : 'border-gray-300 hover:border-primary'
                  }`}
                >
                  {task.status === 'COMPLETED' && <CheckIcon className="w-3.5 h-3.5" />}
                </button>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${task.status === 'COMPLETED' ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                    {task.title}
                  </p>
                  <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                    <span className="uppercase">{task.type}</span>
                    {task.lead && (
                      <Link to={`/leads/${task.lead.id}`} className="text-primary hover:underline">
                        {task.lead.businessName}
                      </Link>
                    )}
                    <span className={priorityColors[task.priority] || ''}>{task.priority}</span>
                    {task.status === 'IN_PROGRESS' && (
                      <span className="text-primary font-medium">In Progress</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {task.status === 'PENDING' && (
                    <button
                      onClick={() => statusMutation.mutate({ id: task.id, status: 'IN_PROGRESS' })}
                      title="Start task"
                      className="p-1.5 text-gray-400 hover:text-primary hover:bg-primary/10 rounded-lg"
                    >
                      <PlayIcon className="w-4 h-4" />
                    </button>
                  )}
                  {task.status !== 'COMPLETED' && (
                    <button
                      onClick={() => startEditing(task)}
                      title="Edit task"
                      className="p-1.5 text-gray-400 hover:text-primary hover:bg-primary/10 rounded-lg"
                    >
                      <PencilSquareIcon className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (window.confirm('Are you sure you want to delete this task?')) {
                        deleteMutation.mutate(task.id);
                      }
                    }}
                    title="Delete task"
                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className={`text-xs ${isOverdue ? 'text-red-600 font-medium' : 'text-gray-400'}`}>
                    {fmtDate(task.dueDate)}
                  </p>
                  {task.assignedTo && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      {task.assignedTo.firstName} {task.assignedTo.lastName}
                    </p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
