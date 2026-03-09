"""CLI module for FilaMan administration tasks."""

import argparse
import asyncio
import getpass
import sys
from sqlalchemy import select

from app.core.database import async_session_maker
from app.core.security import hash_password_async
from app.models.user import User


async def reset_password_core(email: str, new_password: str, session) -> str:
    """
    Reset password for a user by email.
    
    Args:
        email: User email address
        new_password: New password to set
        session: AsyncSession for database access
        
    Returns:
        Confirmation string with user email
        
    Raises:
        ValueError: If user not found
    """
    result = await session.execute(
        select(User).where(User.email == email, User.deleted_at.is_(None))
    )
    user = result.scalar_one_or_none()
    
    if not user:
        raise ValueError(f"User with email '{email}' not found")
    
    user.password_hash = await hash_password_async(new_password)
    await session.commit()
    
    return f"Password reset successfully for user: {user.email}"


async def main_async() -> int:
    """
    CLI entry point for password reset.
    
    Returns:
        Exit code: 0=success, 1=user not found, 2=password error
    """
    parser = argparse.ArgumentParser(
        description="FilaMan CLI - Administration commands",
        prog="python -m app.cli"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    
    # reset-password subcommand
    reset_parser = subparsers.add_parser(
        "reset-password",
        description="Reset password for a user by email"
    )
    reset_parser.add_argument(
        "email",
        help="Email address of the user to reset password for"
    )
    reset_parser.add_argument(
        "--password",
        required=False,
        default=None,
        help="New password (if not provided, will prompt interactively)"
    )
    
    args = parser.parse_args()
    
    # Get password - interactive or from argument
    if args.password:
        password1 = args.password
    else:
        print("Enter new password:")
        try:
            password1 = getpass.getpass()
        except EOFError:
            print("Error: Cannot read password input (non-interactive mode)", file=sys.stderr)
            return 2
    
    if not password1:
        print("Error: Password cannot be empty", file=sys.stderr)
        return 2
    
    if len(password1) < 8:
        print("Error: Password must be at least 8 characters long", file=sys.stderr)
        return 2
    
    # Confirmation only in interactive mode
    if not args.password:
        print("Confirm password:")
        try:
            password2 = getpass.getpass()
        except EOFError:
            print("Error: Cannot read password input (non-interactive mode)", file=sys.stderr)
            return 2
        
        if password1 != password2:
            print("Error: Passwords do not match", file=sys.stderr)
            return 2
    
    # Reset password in database
    try:
        async with async_session_maker() as session:
            message = await reset_password_core(args.email, password1, session)
            print(message)
            return 0
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main_async())
    sys.exit(exit_code)
