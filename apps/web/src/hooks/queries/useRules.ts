import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Rule, CreateRuleInput, UpdateRuleInput } from '@tracearr/shared';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

export function useRules() {
  return useQuery({
    queryKey: ['rules', 'list'],
    queryFn: api.rules.list,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useCreateRule() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (data: Omit<Rule, 'id' | 'createdAt' | 'updatedAt'>) =>
      api.rules.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules', 'list'] });
      toast({
        title: 'Rule Created',
        description: 'The rule has been created successfully.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to Create Rule',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}

export function useUpdateRule() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Rule> }) =>
      api.rules.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules', 'list'] });
      toast({
        title: 'Rule Updated',
        description: 'The rule has been updated successfully.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to Update Rule',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}

export function useDeleteRule() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (id: string) => api.rules.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules', 'list'] });
      toast({
        title: 'Rule Deleted',
        description: 'The rule has been deleted successfully.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to Delete Rule',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}

export function useToggleRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.rules.update(id, { isActive }),
    onMutate: async ({ id, isActive }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['rules', 'list'] });

      // Snapshot the previous value
      const previousRules = queryClient.getQueryData<Rule[]>(['rules', 'list']);

      // Optimistically update to the new value
      queryClient.setQueryData<Rule[]>(['rules', 'list'], (old) => {
        if (!old) return [];
        return old.map((rule) =>
          rule.id === id ? { ...rule, isActive } : rule
        );
      });

      return { previousRules };
    },
    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previousRules) {
        queryClient.setQueryData(['rules', 'list'], context.previousRules);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['rules', 'list'] });
    },
  });
}
