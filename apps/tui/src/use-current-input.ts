import { useInput } from "ink";
import { useCallback, useLayoutEffect, useRef } from "react";

type InputHandler = Parameters<typeof useInput>[0];

export function useCurrentInput(inputHandler: InputHandler): void {
  const inputHandlerRef = useRef(inputHandler);
  useLayoutEffect(() => {
    inputHandlerRef.current = inputHandler;
  }, [inputHandler]);
  const dispatchInput = useCallback<InputHandler>(
    (input, key) => inputHandlerRef.current(input, key),
    [],
  );
  useInput(dispatchInput);
}
