import { SignUp } from "@clerk/nextjs";
import { Logo } from "@/components/logo";

export default function SignUpPage() {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div>
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <SignUp />
      </div>
    </main>
  );
}
